# Deployment and operations

## Topology

Three containers from two images, plus managed services:

| Process        | Image / command                                          | Scaling                                                                        |
| -------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| web            | `infra/docker/web.Dockerfile` (nginx, port 8080)         | stateless; any number                                                          |
| api            | `server.Dockerfile`, `node dist/main-api.js` (port 4000) | stateless; any number behind the web/LB                                        |
| worker         | `server.Dockerfile`, `node dist/main-worker.js`          | any number; jobs are claimed with `SKIP LOCKED`, periodic tasks are idempotent |
| migrate        | `server.Dockerfile`, `node dist/migrate.js`              | run once per release, before api/worker                                        |
| PostgreSQL 16  | managed (RDS / Cloud SQL / Azure DB)                     | backups + PITR enabled                                                         |
| Redis 7        | managed, persistence on                                  | BullMQ + rate limits                                                           |
| Object storage | S3-compatible, private, SSE                              |                                                                                |

TLS terminates at your load balancer or ingress, which forwards to `web:8080`. Do not expose
`api:4000` publicly except through `web` (it would bypass the CSP and the `/metrics` block).

## Database roles (one-time)

```sql
-- as an admin user
CREATE ROLE notetaker_owner LOGIN PASSWORD '…' CREATEROLE;      -- runs migrations, owns tables
CREATE DATABASE notetaker OWNER notetaker_owner;
-- after the first migration (which creates the NOLOGIN group role notetaker_app):
CREATE ROLE notetaker_api LOGIN PASSWORD '…' IN ROLE notetaker_app;
```

Set `DATABASE_MIGRATION_URL` (owner) for the migrate job only and `DATABASE_URL` (notetaker_api) for
api/worker. The runtime role must not be a superuser, the table owner, or have `BYPASSRLS`; the
integration test `the application role is not a superuser and cannot bypass RLS` checks this. If
your managed Postgres does not allow `CREATEROLE` for the owner, create `notetaker_app` manually
before migrating; the migration skips it when it exists. `pg_trgm` must be available.

## Required production configuration

The server refuses to start in production unless: providers are not `mock`, dev login is off,
`COOKIE_SECURE=true`, `PUBLIC_URL` is https, and the example secrets were replaced. Also set:

- `TRUST_PROXY=1` (or the number of proxies) so rate limits see client IPs.
- `METRICS_TOKEN` to expose `/metrics` (otherwise it returns 404 in production); scrape `api:4000`
  directly from your monitoring network, and `WORKER_METRICS_PORT` for workers.
- Secrets (`SESSION_SECRET`, `TOKEN_ENCRYPTION_KEYS`, OAuth/provider secrets) from a secrets manager,
  injected as environment variables. Never bake them into images.

## Release procedure

1. CI must be green: lint, format, typecheck, tests, build, migration on a clean DB, dependency audit,
   secret scan, image scan.
2. Back up / snapshot the database (or confirm PITR).
3. Run the `migrate` job with the new image. Migrations are forward-only and additive and are applied
   transactionally by the Drizzle migrator; re-running is a no-op.
4. Roll out `worker`, then `api`, then `web`.
5. Watch `/api/v1/health/ready`, error rates, `jobs_pending{status="failed"}`.

### Rollback

- Application: redeploy the previous image tags (all components). Job records are versioned by type
  and payloads are minimal, so older workers can process them.
- Schema: migrations are not auto-reverted. If a migration must be undone, write a new forward
  migration, or restore from the pre-release snapshot (data written since then is lost; prefer
  forward fixes).

## Backup and restore

- PostgreSQL: enable automated backups with point-in-time recovery (≥ 7 days). Test a restore
  quarterly into a separate instance and run the app's read-only smoke checks against it.
- Object storage: enable versioning with a lifecycle rule that expires non-current versions after
  the retention window, so deletions remain effective; replicate if required.
- Redis holds no business state (PostgreSQL is authoritative). After a Redis loss, the dispatcher
  re-queues pending jobs and the reaper returns abandoned `queued/running` jobs to `pending` after
  90 minutes.
- Restore order: database → storage → redeploy. After a point-in-time restore, run
  `RETENTION`/deletion jobs again to re-apply deletions that happened after the restore point
  (`meeting.deleted` audit events list them).

**Demonstrate before launch** (BRD release gate): restore the latest backup into staging, sign in,
open a recording, generate minutes.

## Secret rotation

- `TOKEN_ENCRYPTION_KEYS`: add a new key (`k1:…,k2:…`), set `TOKEN_ENCRYPTION_ACTIVE_KEY=k2`, deploy.
  New writes use k2; old values still decrypt with k1. Access tokens are re-encrypted on every refresh;
  refresh tokens and meeting URLs only when rewritten (provider rotation, reconnect, calendar update).
  Keep k1 until `SELECT count(*) FROM calendar_connections WHERE encrypted_refresh_token LIKE 'k1.%'`
  (and the same for `meetings.encrypted_meeting_url`) is zero or those rows are retired.
- `SESSION_SECRET`: rotating it invalidates in-flight OAuth redirects and changes the meeting-URL
  de-duplication hash (manual registrations of the same link may duplicate once). Sessions are
  unaffected (they are random tokens stored hashed).
- OAuth client secrets / provider keys: create the new secret, deploy, then revoke the old one.
- Webhook secrets: follow the provider's dual-secret procedure if supported.

## Monitoring and alerts

Metrics (Prometheus): `http_request_duration_seconds`, `jobs_processed_total{type,outcome}`,
`job_duration_seconds`, `jobs_pending{status}`, `webhook_verification_failures_total`,
`bot_join_failures_total`, `ai_generation_failures_total`. Logs are JSON with `requestId`/`jobId`
and redacted secrets.

Suggested alerts:

| Alert                         | Condition                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| Join failures                 | `increase(bot_join_failures_total[30m]) > 5`                                               |
| Queue backlog                 | `jobs_pending{status="pending"} > 200` for 15 min                                          |
| Dead letters                  | `jobs_pending{status="failed"}` increasing                                                 |
| Webhook verification failures | `increase(webhook_verification_failures_total[10m]) > 10` (misconfigured secret or attack) |
| Storage errors                | `jobs_processed_total{type="recording_ingest",outcome="failed"}` increasing                |
| AI failures                   | `increase(ai_generation_failures_total[1h]) > 10`                                          |
| API errors / latency          | 5xx rate > 1 %, p95 > 500 ms on `/api/v1/meetings`                                         |
| Readiness                     | `/api/v1/health/ready` not 200                                                             |

## Incident response (outline)

1. Triage with the Operations page (`/admin`, admin role via `pnpm admin:grant <userId>`) and logs by
   `requestId`.
2. Provider outage: jobs back off automatically; nothing is marked failed until retries are
   exhausted. Retry dead-lettered jobs from `/admin` once the provider recovers.
3. Suspected credential leak: rotate the secret (above), revoke all sessions
   (`UPDATE sessions SET revoked_at = now()`), review `audit_events`.
4. Data subject requests: deleting a meeting removes audio, transcript, summaries, minutes and
   participants; the tombstone keeps only ids and timestamps.

## Worker sizing

- `media` queue (ingest, transcription) concurrency 2 per worker: ffmpeg and downloads are CPU/IO
  heavy. Scale workers horizontally for more throughput.
- `ai` queue concurrency 4; `realtime` (bot scheduling, calendar sync, deletion) 10.
- Temporary files go to the OS temp dir; size it for the largest recording × media concurrency
  (default limit 1 GiB per recording).
