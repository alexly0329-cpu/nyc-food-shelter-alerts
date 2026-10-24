# NYC Food and Shelter Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build v1 of the shared NYC alert network: providers enroll consenting recipients and post capacity-capped alerts that go out by SMS or voice.

**Architecture:** One TypeScript web service (Fastify) with Postgres. Sends run through a Postgres-backed job queue (pg-boss), so no Redis. Vonage and Tavily are called only from the server, behind small adapter interfaces that tests replace with fakes. The dashboard is the static prototype in `design/index.html`, moved to `public/` and wired to a JSON API.

**Tech Stack:** Node 20, TypeScript, Fastify, `pg`, `pg-boss`, `zod`, `@vonage/server-sdk`, `@tavily/core`, `@node-rs/argon2`, Vitest, Docker Compose (Postgres for tests).

**Spec:** `docs/superpowers/specs/2026-10-24-nyc-food-shelter-alerts-design.md`

## Global Constraints

- Phone numbers are stored as E.164, encrypted at rest. Only a neighborhood centroid is stored, never a street address.
- A recipient is eligible only with an unrevoked consent and `status = 'active'`.
- `consents` is append-only. Rows are never updated except setting `revoked_at`, and never deleted. Retain at least 5 years.
- Channels: `sms` or `voice`. Alert `verification_status`: `verified`, `needs_review`, `rejected`. Delivery `status`: `queued`, `delivered`, `failed`, `stopped`.
- Selection: nearest first, stop at `capacity_cap`, exclude anyone alerted in the last 24 hours.
- Never send an alert unverified. If Tavily or geocoding fails, the alert goes to `needs_review`.
- Never send an alert after its `ends_at`. Failed sends are not retried past `ends_at`.
- Quiet hours are 9 pm to 8 am America/New_York, unless the alert is marked urgent.
- STOP revokes consent and sets the recipient to `stopped` immediately.
- Providers see delivery totals only, never recipient numbers.
- API keys and secrets come from environment variables and are never committed.

## Review Focus

Failure modes the spec implies but does not spell out, most likely first. Each has a test in the task that owns the code.

1. Phone numbers typed in varied formats: `(718) 555-0142`, `718-555-0142`, `+1 718 555 0142`. All normalize to `+17185550142`. Letters or too few digits are rejected. (Task 2)
2. Replies like `stop`, ` Stop `, `STOP.`, `UNSUBSCRIBE` revoke consent. A message like `stopping by at 5` does not. (Task 10)
3. A ZIP outside NYC or unknown is rejected at enrollment with a clear message. (Task 5)
4. An alert whose end is before its start, or already past, is rejected. A double-submit with the same idempotency key creates one alert. (Task 8)
5. Fewer eligible people than the cap means send to all of them with no error. Zero eligible shows the alert as sent to 0, not as a failure. (Tasks 6 and 9)

---

## File Structure

```
package.json, tsconfig.json, vitest.config.ts, docker-compose.yml, .env.example
migrations/001_init.sql
scripts/build-zips.ts           builds src/geo/nyc-zips.json from the Census ZCTA gazetteer
src/config.ts                   env parsing (zod)
src/db.ts                       pool, migrate(), withTx()
src/phone.ts, src/crypto.ts     normalizePhone; encryptPhone/decryptPhone/phoneHash
src/geo/geo.ts, nyc-zips.json   zipToCentroid, distanceKm
src/auth/{users,session}.ts     login, sessions, role guards
src/providers/{apply,admin}.ts  application, approve, suspend
src/recipients/{enroll,revoke}.ts
src/alerts/{select,post,quiet-hours,send,stats}.ts
src/integrations/{tavily,geocode,vonage}.ts
src/webhooks/vonage.ts
src/server.ts, src/routes/*.ts
public/                         the prototype pages, wired to the API
tests/                          one test file per src module
```

---

### Task 1: Scaffold, database and schema

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `docker-compose.yml`, `.env.example`, `.gitignore`, `src/config.ts`, `src/db.ts`, `migrations/001_init.sql`
- Test: `tests/db.test.ts`

**Interfaces:**
- Produces: `getPool(): Pool`, `migrate(pool: Pool): Promise<void>`, `withTx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T>`, `config` (typed env object).

Schema per the spec's data model. Two additions the spec implies: `recipients.phone_hash` (HMAC, unique, used for dedupe and inbound STOP lookup because the phone column is encrypted) and `provider_users.role` (`staff` or `admin`; admins have a null `provider_id`). Add a Postgres trigger on `consents` that raises on DELETE and on any UPDATE other than setting `revoked_at`.

- [ ] **Step 1: Write failing tests** in `tests/db.test.ts`: `migrate creates all six tables plus provider_users`, `consents rejects DELETE`, `consents rejects UPDATE of method`, `consents allows setting revoked_at`.
- [ ] **Step 2: Run** `npx vitest run tests/db.test.ts`. Expected: FAIL (no tables).
- [ ] **Step 3: Implement** the scaffold, `docker-compose.yml` (Postgres 16 on port 5433), and the migration. `migrate` applies `migrations/*.sql` in order and records them in a `schema_migrations` table.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat: scaffold service and schema`.

### Task 2: Phone normalization and encryption

**Files:** Create `src/phone.ts`, `src/crypto.ts`. Test: `tests/phone.test.ts`, `tests/crypto.test.ts`.

**Interfaces:**
- Produces: `normalizePhone(raw: string): string | null` (US numbers to E.164, else null), `encryptPhone(e164: string): Buffer`, `decryptPhone(b: Buffer): string`, `phoneHash(e164: string): string`.

- [ ] **Step 1: Write failing tests.** `normalizePhone` maps `(718) 555-0142`, `718-555-0142`, `+1 718 555 0142` and `17185550142` to `+17185550142`. It returns null for `555-0142`, `abc`, and `+44 20 7946 0958`. `decryptPhone(encryptPhone(x)) === x`. Two encryptions of the same number differ. `phoneHash` is stable for the same number.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** `encryptPhone` uses AES-256-GCM with a random IV prepended to the ciphertext, key from `config.PHONE_ENCRYPTION_KEY` (32 bytes, base64). `phoneHash` is HMAC-SHA256 with `config.PHONE_HASH_KEY`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: phone normalization and encryption`.

### Task 3: NYC geography

**Files:** Create `scripts/build-zips.ts`, `src/geo/geo.ts`, `src/geo/nyc-zips.json`. Test: `tests/geo.test.ts`.

**Interfaces:**
- Produces: `zipToCentroid(zip: string): { lat: number; lng: number } | null`, `distanceKm(a: Point, b: Point): number` (haversine).

v1 uses ZIP codes only; NTA support is deferred. `scripts/build-zips.ts` reads the US Census 2023 ZCTA gazetteer (tab-separated, columns `GEOID`, `INTPTLAT`, `INTPTLONG`) and keeps ZIPs that start with 100–104, 111–114 or 116. It writes the JSON map.

- [ ] **Step 1: Write failing tests.** `zipToCentroid('11216')` is within 0.05 degrees of (40.675, -73.948). `zipToCentroid('90210')` returns null. `zipToCentroid('1121')` returns null. `distanceKm` of 10001 to 11216 is between 8 and 12.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the build script, run it once to commit `nyc-zips.json`, then `geo.ts`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: nyc zip centroids`.

### Task 4: Providers, staff login and access control

**Files:** Create `src/providers/apply.ts`, `src/providers/admin.ts`, `src/auth/users.ts`, `src/auth/session.ts`. Test: `tests/providers.test.ts`, `tests/auth.test.ts`.

**Interfaces:**
- Consumes: `withTx`, tables from Task 1.
- Produces: `applyProvider(db, input: { name; address; contactName; phone; website?; email; password }): Promise<{ providerId: string }>` (status `pending`), `approveProvider(db, adminId, providerId)`, `suspendProvider(db, adminId, providerId)`, `login(db, email, password): Promise<{ sessionToken: string } | null>`, `requireProvider(req): { userId; providerId }` (throws 401, 403 if provider not `approved`), `requireAdmin(req)`.

- [ ] **Step 1: Write failing tests.** A new application has status `pending` and its user cannot enroll or post (`requireProvider` throws 403). After `approveProvider`, it passes. After `suspendProvider`, it throws 403 again. Wrong password returns null. Passwords are stored hashed (argon2), never plain. `requireAdmin` rejects a staff user.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Sessions are random tokens stored hashed in a `sessions` table (add to migration), sent as an `HttpOnly`, `Secure`, `SameSite=Lax` cookie. Log every admin action to an `audit_log` table (add to migration).
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: providers, login and admin approval`.

### Task 5: Enrollment and consent log

**Files:** Create `src/recipients/enroll.ts`, `src/recipients/revoke.ts`. Test: `tests/enroll.test.ts`.

**Interfaces:**
- Consumes: `normalizePhone`, `encryptPhone`, `phoneHash`, `zipToCentroid`.
- Produces: `CONSENT_SCRIPT_VERSION = 'v2-draft'`, `enrollRecipient(db, input: { providerId; phone; channel: 'sms' | 'voice'; language: string; zip: string; method: 'verbal' | 'written'; scriptConfirmed: boolean }): Promise<{ recipientId: string }>` (throws `EnrollError` with code `INVALID_PHONE`, `ZIP_NOT_NYC` or `SCRIPT_NOT_CONFIRMED`), `revokeConsent(db, phoneE164: string): Promise<boolean>`.

- [ ] **Step 1: Write failing tests.** Enrolling inserts one recipient and one consent row with `consent_text_version = 'v2-draft'`. `scriptConfirmed: false` throws `SCRIPT_NOT_CONFIRMED` and inserts nothing. ZIP `90210` throws `ZIP_NOT_NYC`. Letters in the phone throw `INVALID_PHONE`. Enrolling the same number twice reuses the recipient and adds a second consent row. Re-enrolling a stopped recipient sets status back to `active` with a new consent row. `revokeConsent` sets `revoked_at` and status `stopped`, returns false for an unknown number. The stored phone column is not the plain number.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** both in one transaction each.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: enrollment and consent log`.

### Task 6: Recipient selection

**Files:** Create `src/alerts/select.ts`. Test: `tests/select.test.ts`.

**Interfaces:**
- Produces: `selectRecipients(db, input: { lat: number; lng: number; cap: number; now: Date }): Promise<Array<{ id: string; channel: 'sms' | 'voice'; language: string; phone: string }>>`. The phone is decrypted only here, for the send step.

- [ ] **Step 1: Write failing tests** against seeded recipients. Returns nearest first. Stops at `cap`. Excludes `stopped` recipients, recipients with revoked consent, and anyone with a delivery created in the last 24 hours (`now` is injected). With fewer eligible than the cap, returns all of them. With none, returns `[]`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** as one SQL query using a haversine expression, `ORDER BY distance LIMIT cap`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: nearest-first recipient selection`.

### Task 7: Tavily verification and geocoding

**Files:** Create `src/integrations/tavily.ts`, `src/integrations/geocode.ts`. Test: `tests/verify.test.ts`.

**Interfaces:**
- Produces: `verifyProvider(client: TavilyLike, input: { name; address }): Promise<{ status: 'likely_legit' | 'flagged'; detail: string }>`, `verifyAlert(client: TavilyLike, input: { providerName; address; startsAt; endsAt }): Promise<{ status: 'verified' | 'needs_review'; detail: string }>`, `geocodeAddress(address: string, fetchFn?: typeof fetch): Promise<{ lat: number; lng: number } | null>`.

The spec does not say how an alert address becomes coordinates. This plan uses NYC Planning Labs GeoSearch (`https://geosearch.planninglabs.nyc/v2/search`, no key). Any failure returns null, which makes the alert `needs_review`.

- [ ] **Step 1: Write failing tests** with a fake Tavily client. A result mentioning the provider name and street verifies the alert. Zero matching results gives `needs_review`. A thrown error from the client gives `needs_review`, never an exception and never `verified`. `geocodeAddress` returns null on an empty result, on a non-OK response and on a thrown error.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** `TavilyLike` is `{ search(query: string): Promise<{ results: Array<{ title: string; content: string; url: string }> }> }`, so `@tavily/core` fits it and tests pass a fake. Matching rule: a result counts if its text contains the provider name and the street number plus street name, case-insensitive.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: tavily verification and geocoding`.

### Task 8: Posting an alert

**Files:** Create `src/alerts/post.ts`, `src/alerts/quiet-hours.ts`. Test: `tests/post.test.ts`, `tests/quiet-hours.test.ts`.

**Interfaces:**
- Consumes: `verifyAlert`, `geocodeAddress`, `requireProvider`.
- Produces: `postAlert(deps: { db; tavily; geocode; enqueue(alertId: string, runAt: Date): Promise<void>; now: () => Date }, input: { providerId; serviceType: 'food' | 'shelter'; address; startsAt: Date; endsAt: Date; message: string; capacityCap: number; urgent: boolean; idempotencyKey: string }): Promise<{ alertId: string; status: 'verified' | 'needs_review' }>`, `quietHoursDecision(sendAt: Date, endsAt: Date, urgent: boolean): { action: 'send' } | { action: 'defer'; until: Date } | { action: 'expire' }`.

Rules: message at most 100 characters. Cap between 5 and 500. A quiet-hours alert that ends after 8:00 am ET the same morning is deferred to 8:00 am; otherwise it expires. Evaluate in `America/New_York`, including DST.

- [ ] **Step 1: Write failing tests.** Rejects `endsAt <= startsAt`, `endsAt` in the past, cap 4 and 501, a 101-character message. The same `idempotencyKey` twice returns the same `alertId` and creates one row and one enqueue. Verified alert stores `lat/lng`, status `verified`, and enqueues. Tavily returning `needs_review` stores the alert and enqueues nothing. A geocode null gives `needs_review`. `quietHoursDecision`: 3 pm sends. 10 pm not urgent with `endsAt` 11 pm gives `expire`. 10 pm not urgent with `endsAt` 10 am next day gives `defer` to 8:00 am. 10 pm urgent sends. 8:00 am sends. Run a case on the DST change date (2026-03-08) to confirm 8:00 am ET.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Idempotency uses a unique index on `(provider_id, idempotency_key)`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: alert posting and quiet hours`.

### Task 9: Sending

**Files:** Create `src/alerts/send.ts`, `src/integrations/vonage.ts`. Test: `tests/send.test.ts`.

**Interfaces:**
- Consumes: `selectRecipients`, `quietHoursDecision`.
- Produces: `interface Sender { sendSms(to: string, text: string): Promise<{ id: string }>; startCall(to: string, text: string, language: string): Promise<{ id: string }> }`, `runSendJob(deps: { db; sender: Sender; enqueue; now: () => Date }, alertId: string): Promise<void>`, `VONAGE_RATE_PER_SECOND` (config, default 10).

`runSendJob` loads the alert, expires it if `now >= ends_at`, applies `quietHoursDecision`, selects recipients, creates `deliveries` rows as `queued`, then sends each at the configured rate. One failed send marks that delivery `failed` and the loop continues. SMS text: `<Provider>: <message> <address>, <start time>. Reply STOP to opt out.` Voice reads the same text. Language chooses the text-to-speech locale only (map `English` to `en-US`, `Español` to `es-US`, `中文` to `zh-CN`, `Русский` to `ru-RU`; others fall back to `en-US`). The message text is sent as the provider wrote it.

- [ ] **Step 1: Write failing tests** with a fake `Sender`. Sends to every selected recipient by their channel. Marks a throwing send `failed` and still sends the rest. Sends nothing for an alert past `ends_at`. Quiet-hours alert defers via `enqueue` with the right time. Zero eligible leaves zero deliveries and no error. Running the job twice for one alert does not send twice (skip recipients that already have a delivery for that alert).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `runSendJob` and the Vonage `Sender` using the Messages API for SMS and the Voice API with an inline talk NCCO.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: alert send job with vonage`.

### Task 10: Vonage webhooks

**Files:** Create `src/webhooks/vonage.ts`. Test: `tests/webhooks.test.ts`.

**Interfaces:**
- Produces: `isStopKeyword(text: string): boolean`, `handleInbound(deps: { db }, msg: { from: string; text: string }): Promise<{ reply: string | null }>`, `handleStatus(deps: { db }, evt: { messageId: string; status: string }): Promise<void>`, `verifyVonageSignature(rawBody: string, signature: string, secret: string): boolean`.

- [ ] **Step 1: Write failing tests.** `isStopKeyword` is true for `STOP`, `stop`, ` Stop `, `STOP.`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT`, and false for `stopping by at 5`, `please don't stop`, and an empty string. A STOP from an enrolled number revokes consent, sets the recipient to `stopped`, marks that recipient's most recent delivery `stopped`, and returns a reply confirming. `HELP` returns a reply naming the network and a contact line. An unknown sender gets no error. A `delivered` status event updates the delivery, a `failed` event does the same, and an unknown message id is ignored. A bad signature is rejected.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** STOP match is on the trimmed, punctuation-stripped, uppercased whole message.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: vonage inbound and status webhooks`.

### Task 11: API routes and dashboard wiring

**Files:** Create `src/server.ts`, `src/routes/{auth,alerts,enroll,admin,webhooks}.ts`, `src/alerts/stats.ts`. Move `design/index.html` to `public/index.html`. Test: `tests/routes.test.ts`.

**Interfaces:**
- Produces: `alertTotals(db, providerId): Promise<Array<{ alertId; title; address; status; verification: string; texted: number; delivered: number; failed: number; stopped: number }>>`, routes `POST /api/login`, `POST /api/enroll`, `POST /api/alerts`, `GET /api/alerts`, `POST /api/apply` (calls `verifyProvider` and stores the result for the admin queue), `POST /api/admin/providers/:id/approve`, `POST /api/admin/alerts/:id/approve` (moves a `needs_review` alert to `verified` and enqueues it), `POST /webhooks/vonage/inbound`, `POST /webhooks/vonage/status`.

- [ ] **Step 1: Write failing tests** with Fastify `inject`. Unauthenticated `GET /api/alerts` is 401. Provider A's `GET /api/alerts` never includes provider B's alerts. Responses contain no phone numbers. `POST /api/enroll` with an unconfirmed script is 400 with the error code. Webhook routes reject a bad signature with 401. A staff user cannot call the admin approve routes (403). Admin-approving a `needs_review` alert enqueues exactly one send.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** routes with `zod` bodies, and replace the prototype's demo data and fake submit handlers with `fetch` calls. Keep the design as is.
- [ ] **Step 4: Run.** Expected: PASS. Then start the server and click through each screen in a browser.
- [ ] **Step 5: Commit** `feat: api routes and wired dashboard`.

### Task 12: Operations and launch checklist

**Files:** Create `src/ops/daily-summary.ts`, `README.md`, `docs/launch-checklist.md`. Test: `tests/ops.test.ts`.

**Interfaces:**
- Produces: `dailySummary(db, day: Date): Promise<{ alerts: number; sent: number; delivered: number; failed: number; stopped: number; deliveryRate: number }>`, plus an error log line `{"event":"send_failed"|"webhook_error", ...}` that hosting alerts can match.

- [ ] **Step 1: Write failing tests.** `dailySummary` counts correctly on seeded data and returns `deliveryRate` 0 (not NaN) with no sends.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** and write the README (setup, env vars) and the launch checklist: Vonage 10DLC registration, legal review of the consent script, retention and quiet hours, a real-phone end-to-end test before any real enrollment, and who staffs admin approval.
- [ ] **Step 4: Run** the full suite `npx vitest run`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat: daily summary and launch checklist`.
