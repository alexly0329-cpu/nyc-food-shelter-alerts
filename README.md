# NYC food and shelter alerts

A service for NYC food banks and shelters to send SMS and voice alerts ("hot meals tonight at 5 pm, 214 Marcy Ave") to people who agreed to receive them. Organizations apply, an admin approves them, staff enroll recipients with recorded consent, and post alerts that go out to enrolled people nearby.

**Architecture.** One Node 20+ TypeScript process: a Fastify HTTP server (JSON API under `/api`, Vonage webhooks under `/webhooks`, and a static staff dashboard from `public/`) plus a pg-boss worker that sends alerts. Everything lives in one Postgres database (app tables, consent log, and the pg-boss job queue); migrations in `migrations/` run on startup. Vonage sends the SMS and voice calls. Tavily checks that an applying organization and its address exist, and a geocoder places alert addresses. Phone numbers are encrypted at rest and looked up by keyed hash; providers never see recipient numbers.

## Prerequisites

- Node 20 or newer
- Docker (for the local Postgres)

## Setup

```sh
docker compose up -d --wait        # Postgres 16 on localhost:5433 (same as: npm run db:up)
npm install
cp .env.example .env               # then fill in values; never commit real secrets
```

`.env` is not loaded automatically: export the variables in your shell (or use your process manager) before `npm start`-style runs below.

### Environment variables

| Name | Required | What it is |
| --- | --- | --- |
| `DATABASE_URL` | Required | Postgres connection string, e.g. `postgres://postgres:postgres@localhost:5433/alerts`. Used by the app, pg-boss, the seed script and `npm run summary`. |
| `PHONE_ENCRYPTION_KEY` | Required | 32 random bytes, base64. Encrypts stored phone numbers. The app refuses to start if it is not 32 bytes. |
| `PHONE_HASH_KEY` | Required | 32 random bytes, base64. Keyed hash used to look recipients up and detect duplicates. |
| `TAVILY_API_KEY` | Optional | Tavily API key for checking applying organizations. Without it, applying still works but the organization is not verified. |
| `VONAGE_APPLICATION_ID` | Required to send | Vonage application ID (Messages and Voice APIs). Read when the first message is sent, not at boot. |
| `VONAGE_PRIVATE_KEY` | Required to send | The application's private key: an inline PEM (use `\n` for newlines) or a path to a PEM file. |
| `VONAGE_NUMBER` | Required to send | Your Vonage number in E.164, e.g. `+12125550100`. Sender for SMS and calls; also read when building voice text ("text STOP to ..."). |
| `VONAGE_SIGNATURE_SECRET` | Required in production | Signature secret for signed webhooks. If unset, every webhook is rejected with 401 (so STOP replies are not processed) and a warning prints at boot. |
| `VONAGE_RATE_PER_SECOND` | Optional | Send rate cap, positive integer, default 10. |
| `MAX_ALERT_KM` | Optional | Furthest a recipient can be from the alert address, in km. Positive number, default 5. Recipients beyond it are never messaged. |
| `PORT` | Optional | HTTP port, default 3000. |
| `NODE_ENV` | Optional | Set to `production` in production: it turns on the `Secure` flag for session cookies and makes the seed script refuse to run. `test` selects test defaults. |
| `DEV_SEED_PASSWORD` | Dev only | Password (10+ characters) for the demo accounts created by `npm run seed:dev`. |
| `VITEST` | Set by the test runner | Silences request logging and enables test-only defaults. Do not set it yourself. |

### Generate the two keys

```sh
openssl rand -base64 32    # run twice: once for PHONE_ENCRYPTION_KEY, once for PHONE_HASH_KEY
```

Warning: if `PHONE_ENCRYPTION_KEY` is lost, every stored phone number is unrecoverable. Back it up somewhere separate from the database. There is no key rotation yet. Changing `PHONE_HASH_KEY` breaks recipient lookups (STOP and duplicate detection).

## Run

There is no `start` script yet; run the entry point with tsx (the host must export the variables above):

```sh
npx tsx src/main.ts        # serves the dashboard at http://localhost:3000
```

| Command | What it does |
| --- | --- |
| `npm run db:up` | Start the local Postgres (docker compose, port 5433) |
| `npm test` | Run the test suite (vitest) |
| `npm run typecheck` | Type-check with tsc |
| `npm run seed:dev` | Create demo data in a dev database (see below) |
| `npm run summary [-- YYYY-MM-DD]` | Print the daily summary as JSON (default: today, New York time). Needs `DATABASE_URL`, `PHONE_ENCRYPTION_KEY` and `PHONE_HASH_KEY` set, as does any script that imports the db module (config validates the keys at import) |

## Tests

```sh
npm run db:up
npm test
```

The test setup drops and recreates the `public` schema, so it refuses to run unless `DATABASE_URL` points at a `localhost` (or `127.0.0.1`) database whose name ends in `_test`. With no `DATABASE_URL` set, tests use `postgres://postgres:postgres@localhost:5433/alerts_test` (the docker compose database).

## Seed a dev database

```sh
DEV_SEED_PASSWORD='choose-10+-chars' npm run seed:dev
```

Needs `DATABASE_URL`, `PHONE_ENCRYPTION_KEY` and `PHONE_HASH_KEY` set. Creates an approved "Demo Pantry", a staff user `demo@example.test`, an admin `admin@example.test` (both with the password you gave) and two test recipients. Safe to re-run. Never run it against production (it refuses when `NODE_ENV=production`, but do not rely on that alone). The seed script is currently the only way to create an admin account.

## Vonage webhook setup

In the Vonage dashboard, for your application (Messages capability):

- Inbound URL: `https://<your-host>/webhooks/vonage/inbound` (replies such as STOP and HELP)
- Status URL: `https://<your-host>/webhooks/vonage/status` (delivery receipts)

Use signed webhooks (JWT signature) and set the signature secret as `VONAGE_SIGNATURE_SECRET`. Requests with a missing or invalid signature get 401 and do nothing. Both URLs must be reachable over HTTPS from the internet.

## Admin workflow

There is no admin screen in v1: approvals are API calls. Send `Content-Type: application/json` on every POST (the API returns 415 otherwise).

```sh
HOST=http://localhost:3000

# Log in as admin; the session cookie is saved in cookies.txt
curl -c cookies.txt -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.org","password":"<password>"}' $HOST/api/login

# List pending providers (status: pending | approved | suspended; omit for all)
curl -b cookies.txt "$HOST/api/admin/providers?status=pending"

# Approve or suspend a provider (suspending also stops its queued alerts from sending)
curl -b cookies.txt -X POST -H 'Content-Type: application/json' $HOST/api/admin/providers/<provider-id>/approve
curl -b cookies.txt -X POST -H 'Content-Type: application/json' $HOST/api/admin/providers/<provider-id>/suspend

# List alerts waiting for review (status: needs_review (default) | verified | rejected)
curl -b cookies.txt "$HOST/api/admin/alerts?status=needs_review"

# Approve one: marks it verified and queues it for sending
curl -b cookies.txt -X POST -H 'Content-Type: application/json' $HOST/api/admin/alerts/<alert-id>/approve
```

Each provider listing includes the stored Tavily result so you can judge whether the organization is real. Alert approval fails with 409 if the provider is not approved or the address cannot be located.

## Operations

- Structured log lines (one JSON object per line on stdout): `send_failed`, `webhook_error`, `webhook_rejected`, `queue_error`. They carry ids, channel and route only, never phone numbers or message text. Alert on them in your host.
- `npm run summary` prints `{alerts, sent, delivered, failed, stopped, deliveryRate}` for one New York calendar day. `sent` means attempted sends. Run it daily from a scheduler.

See [docs/launch-checklist.md](docs/launch-checklist.md) before enrolling real people.
