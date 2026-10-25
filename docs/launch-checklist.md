# Launch checklist

Do or decide each item before real people are enrolled.

## Legal and carrier

- [ ] **Start Vonage 10DLC brand and campaign registration first.** It takes days to weeks, and US carriers filter unregistered A2P traffic.
- [ ] **Lawyer review of the consent script wording, the 5-year consent retention period and the 9 pm to 8 am quiet-hours window.** These are legal judgments, not engineering ones. The script now says "We send no more than one message a day." (version `v2-draft`) and still needs that review.
- [ ] **Opt-in confirmation SMS at enrollment is not sent.** 10DLC campaign vetting often expects one; decide whether to add it before registering the campaign.
- [ ] **Decide who staffs admin approval** (providers and `needs_review` alerts) and how fast they respond. Alerts are time-sensitive.

## Configuration

- [ ] **Configure Vonage inbound and status webhook URLs and the signature secret** (`/webhooks/vonage/inbound`, `/webhooks/vonage/status`, `VONAGE_SIGNATURE_SECRET`). Without the secret every webhook is rejected and STOP silently stops working.
- [ ] **Put TLS in front of the app and set `NODE_ENV=production`.** Session cookies only get `Secure` in production.
- [ ] **Create the first admin in production with `ADMIN_PASSWORD=... npm run create-admin -- <email>`** (see the README admin workflow), not the dev seed.
- [ ] **Never run the dev seed script, and never keep its demo accounts, in production.** It creates known-email accounts with a shared password.
- [ ] **Back up the database and keep consent records at least 5 years.** Consent proof is the legal defense.
- [ ] **Back up `PHONE_ENCRYPTION_KEY` separately from the database.** Losing it makes all stored numbers unrecoverable, and there is no key rotation yet.
- [ ] **Revoke `TRUNCATE` on the `consents` table from the application database role at deploy.** Consent proof must not be erasable by the app account.
- [ ] **Run the app with `npm start` (tsx), not a compiled `dist/` build.** A compiled build resolves `migrations/` and `public/` relative to the source tree and would not find them; fix the paths first if you compile.
- [ ] **Set up hosting alerts** on the log events `send_failed`, `webhook_error`, `webhook_rejected`, `queue_error`, and schedule `npm run summary` daily. Otherwise failures are invisible.

## Verify with real services

- [ ] **Confirm Vonage voice supports the `zh-CN` text-to-speech locale** (it may need `cmn-CN`) and the other mapped locales (`en-US`, `es-US`, `ru-RU`). A wrong locale means a voice call that fails or is unintelligible.
- [ ] **Verify the Vonage Voice callback signature scheme.** Set the Voice application's event URL to `/webhooks/vonage/status`; signed Voice callbacks must verify with Vonage, because a different scheme is rejected (401) and voice deliveries would stay `queued`.
- [ ] **Tune `MAX_ALERT_KM`** (default 5 km) once you see real recipient density; too small reaches no one, too large wastes the one-message-a-day allowance.
- [ ] **STOP handling:** the keywords STOP, STOPALL, STOP ALL, UNSUBSCRIBE, CANCEL, CANCEL ALL, CANCELAR, END, QUIT, REVOKE, OPT OUT, ALTO, PARAR and BAJA (any case, spacing, punctuation or fullwidth form) opt out. Staff can also opt a number out (`POST /api/optout`, the Enroll view) and admins can (`POST /api/admin/optout`). Include both in staff training: "stop calling me" said aloud must be honored.
- [ ] **Run an end-to-end test with real phones before any real enrollment:** enroll, post an alert, receive it, reply STOP, reply HELP, and check the delivery receipt updates the status.

## Known gaps in v1 (decide, then fix or accept)

- [ ] **Hours checks are heuristic.** Hours are parsed from Tavily search-result text (New York time) and stored as `hours_check`. A `conflict` (listed hours do not cover the alert start) holds the alert in `needs_review`; hours that are absent (`unconfirmed`) do not, so such alerts are still sent. Parsing can miss or misread formats (for example a range like `9-5` with no am/pm is ignored, and when the text also has other parsed hours a would-be conflict is downgraded to `unconfirmed`), so admins should still judge hours when it matters.
- [ ] **Address matching is strict.** Direction words ("W" and "West"), unit suffixes in the alert address and a leading "St" right after the house number (Saint) are now normalized, but borough and ZIP are not part of the Tavily match (the geocode and provider name are the other guards), but other spelling differences (typos, "Avenue of the Americas" vs "6th Ave") still fail, so some real alerts will land in `needs_review` and need an admin approval.
- [ ] **The address lookup still trusts mid-confidence matches.** Fallback matches and confidence below 0.7 are rejected (the alert goes to `needs_review`); admins must still watch for wrong locations.
- [ ] **Language only chooses the voice-call locale.** Message text is sent exactly as the provider wrote it; there is no translation. Tell providers to write in the recipient's language.
- [ ] **A send that times out (10 s) leaves its delivery claimed with no `vonage_id`.** The outcome is unknown and a late status webhook cannot match it; the person is never messaged twice. Review these rows by hand.
- [ ] **No rate limiting on the login and apply endpoints yet.** Password guessing and application spam are possible.
- [ ] **Client-side time checks use browser time; the server is authoritative.** The dashboard's 24-hour and quiet-hours hints follow the browser clock and time zone, the server decides.
- [ ] **There is no admin screen.** Approval is API-only today (see the README admin workflow); decide whether staff can use curl or a screen must be built first.
- [ ] **Crashed send jobs rely on pg-boss retries** (3 retries with backoff). A delivery with `queued`, `claimed_at` set and no `vonage_id` means "outcome unknown" and is never retried, so a person is never messaged twice. Review those rows by hand after a crash.
- [ ] **The staff UI loads Google Fonts.** Self-host the fonts later to avoid third-party requests from the dashboard.
