# NYC Food and Shelter Alerts: Design Spec

Date: 2026-10-24
Status: Draft, awaiting owner review

## Purpose

Food banks and shelters in New York City post alerts about open food or shelter. People in need receive those alerts by text message or phone call, based on where they are. Alerts are spread across providers and regions so no single site is overwhelmed.

Success means a person in need gets a timely, nearby, accurate alert on a basic phone with little or no data.

## Decisions

| Question | Decision |
|---|---|
| Medium | Recipients use SMS and voice only, with no app or account. Providers use a responsive web dashboard. An AI agent is a possible later layer, not part of v1. |
| How people get on the list | Provider staff enroll them in person and capture consent on the spot (verbal or written). |
| Who receives an alert | One shared NYC network. Any enrolled person within range can receive any verified provider's alert. |
| Preventing overload | Each alert has a capacity cap. The system messages the nearest eligible people until it reaches the cap, then stops. |
| Tavily's role | Verify providers at sign-up and verify each alert's address and hours before sending. |
| Vonage's role | SMS and voice delivery, inbound STOP and HELP handling, delivery status webhooks. |
| Build approach | A small custom web app with Postgres. No-code was rejected because the consent log and cap logic must be exact. An AI-agent-first design was rejected because free-form model output must not control real messages to vulnerable people. |

## Architecture

One web application with a Postgres database and a job queue for sends. The provider dashboard is a responsive web UI. Vonage and Tavily are called from the server only. Keys live in environment variables and are never committed.

## Data model

- **providers**: name, address, contact, `verified_at`, Tavily result, status (pending, approved, suspended).
- **provider_users**: staff login, tied to one provider. All actions are logged.
- **recipients**: phone (E.164, encrypted at rest), channel (sms or voice), language, neighborhood (NYC ZIP or NTA with centroid lat/lng), status (active or stopped), `enrolled_by_provider_id`.
- **consents**: append-only log. Fields: recipient, enrolling provider, method (verbal or written), `consent_text_version`, timestamp, `revoked_at`. Rows are never edited and are kept at least 5 years, subject to legal review.
- **alerts**: provider, message, service type (food or shelter), location, `starts_at`, `ends_at`, `capacity_cap`, `urgent` flag, `verification_status` (verified, needs_review, rejected), idempotency key.
- **deliveries**: alert, recipient, Vonage message or call id, status (queued, delivered, failed, stopped).

Only recipients with an unrevoked consent and status active are eligible. Only a neighborhood centroid is stored, never a street address.

## Alert flow

1. Staff post an alert: service type, address, start and end time, message, capacity cap.
2. The server checks that the provider is approved and that the cap and times are sane.
3. Tavily checks the address and hours. A clear match marks the alert verified. A weak or conflicting match marks it needs_review, and nothing is sent until the provider fixes it or an admin approves it.
4. One query selects eligible recipients ordered by distance from the alert location. It excludes anyone alerted in the last 24 hours and stops at the cap.
5. Sends go through a rate-limited queue. SMS or voice follows each recipient's channel and language.
6. Vonage webhooks update delivery status. Failed sends are not retried past the alert's end time. An expired alert is never sent late.
7. Inbound STOP revokes consent and sets the recipient to stopped immediately. HELP replies with the sending organization's name and a contact line.

Failure rules: if Tavily is unavailable the alert goes to needs_review and never auto-sends unverified. If Vonage rejects one send, that delivery is marked failed and the rest continue. A repeated submit with the same idempotency key cannot send twice.

## Provider onboarding and access

1. A provider applies with organization name, address, contact person, phone and a website link if any.
2. Tavily checks that the organization and address exist on the web.
3. A human admin approves each provider. Only approved providers can enroll recipients or post alerts.
4. Staff log in by email and password or magic link. Each user belongs to one provider.
5. Before enrolling anyone, staff read a consent script aloud and confirm they did. The script version is stored in `consents`.
6. An admin can suspend a provider at any time. This blocks new alerts and enrollments and does not change existing recipients' consent.

## Compliance and operations

Compliance (US, NYC). The owner should have counsel review the consent script, retention period and quiet-hours window before launch.

- TCPA: the in-person script plus the `consents` log is the evidence of prior express consent. The script must say calls are included.
- A2P 10DLC: US application-to-person SMS requires brand and campaign registration through Vonage. It takes days to weeks and is a launch dependency, so it starts first.
- STOP and HELP keywords are handled automatically.
- Quiet hours: no alerts between about 9 pm and 8 am unless the provider marks the alert urgent, for example overnight shelter beds.
- Privacy: phone numbers are encrypted at rest with role-based access. A provider sees only totals for its alerts, never recipient numbers. Selection runs on the server.

Operations: alerts for failed sends and webhook errors, and a daily delivery-rate summary.

Testing: unit tests for recipient selection (cap, distance, exclusions, consent). Integration tests against Vonage and Tavily sandboxes or mocks. A manual end-to-end test with real phones before any real enrollment.

## Provider dashboard UI

A static prototype is in `design/index.html`. It covers login, an alerts list with delivery totals, a new-alert form with a capacity stepper and live message preview, and an enrollment form gated on the read-aloud consent step. It is mobile-first with a bottom tab bar that becomes a left rail on tablets and desktops. Type is Archivo for headings and Atkinson Hyperlegible for body text. The one accent is crosswalk yellow. Status is always shown with words or icons, never color alone.

## v1 scope

In: provider sign-up and admin approval, staff login, enrollment with consent log, alert posting, Tavily verification, SMS and voice sending, capacity-cap selection, delivery tracking, STOP and HELP handling.

Out for v1: inbound "where can I eat now?" queries, the AI agent layer, Tavily gap-filling for providers that have not signed up, native mobile apps.

## Open items

- Legal review of consent wording, retention period and quiet hours.
- Vonage 10DLC brand and campaign registration.
- Who staffs admin approval.
- Language list for recipients and for voice.
- Hosting choice and backup plan for the database.
