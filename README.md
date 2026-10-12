# Meeting Notetaker

Records scheduled Google Meet and Microsoft Teams meetings through a meeting-bot provider, then
gives each user a private dashboard with the audio, a transcript, an AI summary and formal
Minutes of Meeting they can copy in one click.

- **Frontend:** React + TypeScript (Vite, React Router, TanStack Query, Radix)
- **Backend:** Node.js 22 + TypeScript (Express, Zod, Drizzle), separate API and worker processes
- **Data:** PostgreSQL 16 (row-level security), Redis 7 (BullMQ), local or S3-compatible storage

Requirements: [`docs/BRD.md`](docs/BRD.md) · Design decisions: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·
Provider setup: [`docs/PROVIDERS.md`](docs/PROVIDERS.md) · Operations: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) ·
Progress: [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md) · API: [`docs/openapi.json`](docs/openapi.json)

> **Status:** the application runs end to end with **mock** meeting-bot, speech-to-text and AI
> providers. No real recording provider has been selected or verified yet, and the Google,
> Microsoft, Deepgram and Anthropic integrations are implemented but not verified against live
> accounts. Mock providers are refused in production. See `docs/IMPLEMENTATION_STATUS.md`.

## Quick start (Docker)

```bash
pnpm setup:env          # or: cp .env.example .env  and fill in the secrets it marks [required]
docker compose up --build
```

Open <http://localhost:8080>, choose **Sign in as test user**, accept the recording notice, then
**Record a meeting link** with any `https://meet.google.com/abc-defg-hij`-style link and a start
time of now. With the mock provider the meeting moves through Joining → In progress → Processing →
Completed in about 20 seconds, and the summary appears shortly after. Open **Meeting Minutes** and
use **Copy minutes**.

Compose runs `migrate` once, then `api`, `worker` and `web` (nginx). Swagger UI:
<http://localhost:4000/api/docs>.

## Local development without Docker

Prerequisites: Node.js 22, pnpm 10 (`corepack enable`), PostgreSQL 16, Redis 7, ffmpeg/ffprobe.

```bash
pnpm install
pnpm setup:env
```

Create the database and roles (once), matching the URLs in `.env`:

```bash
psql -U postgres -c "CREATE ROLE notetaker_owner LOGIN PASSWORD 'owner_dev_password' CREATEROLE"
psql -U postgres -c "CREATE DATABASE notetaker OWNER notetaker_owner"
psql -U postgres -c "CREATE ROLE notetaker_app NOLOGIN"
psql -U postgres -c "CREATE ROLE notetaker_app_user LOGIN PASSWORD 'app_dev_password' IN ROLE notetaker_app"
psql -U postgres -d notetaker -c "CREATE EXTENSION IF NOT EXISTS pg_trgm"
```

Then:

```bash
pnpm db:migrate         # applies migrations as the owner role
pnpm db:seed            # optional demo data: demo@example.com / other@example.com
pnpm dev                # API + worker on :4000 (one process), web on :5173 with /api proxy
```

Open <http://localhost:5173>. In `.env`, keep `PUBLIC_URL=http://localhost:5173`.

### Mock scenarios

Put a tag in the meeting title to exercise error states with the mock providers:

| Title tag                   | Result                                                              |
| --------------------------- | ------------------------------------------------------------------- |
| _(none)_                    | full success: recording, transcript, summary                        |
| `[mock:admission-timeout]`  | bot waits in the lobby, then fails "not admitted"                   |
| `[mock:denied]`             | host denies the bot                                                 |
| `[mock:no-recording]`       | call ends but no recording is produced                              |
| `[mock:duplicate-webhooks]` | every webhook is delivered twice (no duplicates appear)             |
| `[mock:out-of-order]`       | events arrive out of order (state never goes backwards)             |
| `[mock:empty-transcript]`   | recording stored; transcript fails "no speech detected"; no summary |
| `[mock:short-transcript]`   | summary/minutes say the transcript is insufficient                  |

## Commands

| Command                                                | What it does                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------- |
| `pnpm dev`                                             | API + worker (watch) and Vite dev server                            |
| `pnpm lint` / `pnpm format`                            | ESLint (strict, zero warnings) / Prettier                           |
| `pnpm typecheck`                                       | `tsc` in strict mode for all packages                               |
| `pnpm test`                                            | all tests (needs PostgreSQL; see below)                             |
| `pnpm build`                                           | server bundle (`apps/server/dist`) and web bundle (`apps/web/dist`) |
| `pnpm check`                                           | lint + typecheck + test + build                                     |
| `pnpm db:migrate` / `pnpm db:seed`                     | migrations / development seed (refuses production)                  |
| `pnpm --filter @notetaker/server db:generate`          | generate a migration after editing `src/db/schema.ts`               |
| `pnpm --filter @notetaker/server admin:grant <userId>` | grant the operations (admin) role                                   |
| `pnpm openapi`                                         | regenerate `docs/openapi.json`                                      |

### Tests

Server integration tests create a throw-away database, migrate it, and connect with a
**non-superuser** role so row-level security is really enforced. They need a PostgreSQL superuser URL
(default `postgres://postgres@127.0.0.1:5432/postgres`; override with `TEST_DATABASE_ADMIN_URL`) and
`ffmpeg` on the PATH. Redis is not needed for tests.

Coverage highlights: cross-user isolation on every endpoint and at the database layer; webhook
signature, replay, duplicate and out-of-order handling; the full record → transcribe → summary →
minutes pipeline; calendar sync de-duplication, reschedule, cancellation, cursor expiry and revoked
consent; job retries, dead-lettering and admin retry; and frontend loading, empty, failed,
processing and completed states, Summary, Meeting Minutes and Copy minutes (granted and denied).

## Environment variables

Every variable is documented in [`.env.example`](.env.example). The server validates the
configuration at startup and lists every problem. Minimum for local development: `DATABASE_URL`,
`SESSION_SECRET`, `TOKEN_ENCRYPTION_KEYS`, `TOKEN_ENCRYPTION_ACTIVE_KEY` (created by
`pnpm setup:env`). In production the server additionally refuses mock providers, dev login,
non-HTTPS `PUBLIC_URL` and insecure cookies.

## Project layout

```
apps/server       API (main-api.ts) and worker (main-worker.ts); drizzle/ migrations; test/ integration tests
apps/web          React SPA
packages/shared   API schemas, meeting state machine, URL detection, minutes renderer
infra/            Dockerfiles, nginx template, Postgres init script
docs/             BRD, architecture, providers, deployment, implementation status, OpenAPI
```
