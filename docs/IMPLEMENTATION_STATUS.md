# Implementation status

Last updated: 12 October 2026. Legend: ✅ done and tested · 🟡 implemented, not verified against a
live provider · ⛔ blocked on external setup · ⏳ not started / follow-up.

## Verification performed

| Check                                                                                                                | Result                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` (ESLint, zero warnings), `pnpm format:check`                                                             | pass                                                                                                                                  |
| `pnpm typecheck` (strict TypeScript, all packages)                                                                   | pass                                                                                                                                  |
| `pnpm test` — shared 31, server 118, web 19                                                                          | 168 pass                                                                                                                              |
| `pnpm build` (server bundle, web bundle)                                                                             | pass                                                                                                                                  |
| Migrations on a clean database, re-run idempotent                                                                    | pass                                                                                                                                  |
| Live run: API + worker + Redis/BullMQ + mock provider delivering signed webhooks over HTTP                           | meeting reached Completed with recording, transcript, summary and minutes                                                             |
| Production packaging (`pnpm deploy --prod` + bundle) run as separate API and worker processes                        | pass; production config guard rejects mock providers, dev login, insecure cookies                                                     |
| Visual review (headless Chromium): login, dashboard, meetings, detail, minutes, settings; desktop, mobile, dark mode | reviewed; two issues found and fixed                                                                                                  |
| Docker images (`docker build`), `docker compose up`                                                                  | ⛔ not run: Docker Hub is not reachable from the build environment. `docker compose config` validates. CI builds and scans the images |

## Slices

| #   | Slice                                                                                     | Status                                                               |
| --- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | Scaffolding, strict TS, lint/format, env validation, Docker/Compose, CI, health endpoints | ✅ (Docker build not run locally, see above)                         |
| 2   | Authentication and account isolation                                                      | ✅ OIDC code + 🟡 live Google/Microsoft sign-in                      |
| 3   | Dashboard and meeting data model                                                          | ✅                                                                   |
| 4   | Calendar integrations and sync                                                            | ✅ sync logic · 🟡 live Google Calendar / Microsoft Graph            |
| 5   | Meeting-bot provider adapter + mock                                                       | ✅ interface, mock, webhooks, reconciliation · ⛔ real provider      |
| 6   | Recording ingestion, storage, playback                                                    | ✅ local storage · 🟡 S3 (adapter written, not run against S3/MinIO) |
| 7   | Transcription                                                                             | ✅ pipeline + mock · 🟡 Deepgram                                     |
| 8   | Summary and Minutes generation                                                            | ✅ pipeline + mock · 🟡 Anthropic                                    |
| 9   | Copy minutes                                                                              | ✅                                                                   |
| 10  | Operational/security hardening                                                            | ✅ (items under "Follow-ups")                                        |

## BRD acceptance criteria (section 15)

| #   | Criterion                                                                     | Status            | Evidence                                                                                                                                                                 |
| --- | ----------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Sign in with Google/Microsoft; sign out securely                              | 🟡                | OIDC flow + ID-token verification unit-tested (`auth/oauth.test.ts`); sessions/logout/logout-all tested (`test/auth.test.ts`). Needs real OAuth clients (PROVIDERS §1–2) |
| 2   | Calendar access separately authorized and revocable                           | ✅ / 🟡           | Separate consent + encrypted tokens + disconnect/revoke tested with doubles (`test/calendar.test.ts`)                                                                    |
| 3   | Eligible Meet/Teams events appear without duplicates after repeated sync      | ✅ / 🟡           | `calendar.test.ts`, adapter fixtures (`calendar/adapters.test.ts`)                                                                                                       |
| 4   | Manual registration and auto-registration preference                          | ✅                | `test/meetings.test.ts`, `calendar.test.ts` (auto only with explicit opt-in + acknowledged notice)                                                                       |
| 5   | Bot session scheduled; joining/recording shown only when provider confirms    | ✅ mock / ⛔ real | `test/pipeline.test.ts` (stays Queued until provider events)                                                                                                             |
| 6   | Audio stored privately, linked to the correct meeting                         | ✅                | pipeline + isolation tests; generated keys, ownership-checked streaming                                                                                                  |
| 7   | Row shows correct date/time, platform, status                                 | ✅                | UI tests (time-zone rendering), API listing tests                                                                                                                        |
| 8   | Authorized user can play/download; unauthorized cannot                        | ✅                | pipeline (Range, download headers), isolation (404 for others, 401 anonymous)                                                                                            |
| 9   | Summary shows the selected meeting's summary or processing/failure            | ✅                | `apps/web/src/test/app.test.tsx`, pipeline tests                                                                                                                         |
| 10  | Meeting Minutes displays or generates structured MoM                          | ✅                | auto-generation on open, idempotent generate endpoint                                                                                                                    |
| 11  | Discussion points, decisions, action items; missing owners/dates not invented | ✅                | grounding guard (`ai/ai.test.ts`), pipeline assertions, "Not specified" rendering                                                                                        |
| 12  | Copy minutes copies the displayed text with feedback                          | ✅                | UI tests: exact text, success toast, denied-permission fallback                                                                                                          |
| 13  | Recording/transcription/summary/minutes statuses independent                  | ✅                | AI failure keeps meeting Completed; empty transcript keeps recording                                                                                                     |
| 14  | Duplicate webhooks don't duplicate artifacts or cause invalid transitions     | ✅                | inbox dedupe, idempotent job keys, out-of-order tests                                                                                                                    |
| 15  | User A cannot access user B's content (UI or API)                             | ✅                | `test/isolation.test.ts`: every endpoint + RLS at the database layer                                                                                                     |
| 16  | Deletion revokes access and removes stored/derived artifacts                  | ✅                | `meetings.test.ts`: files removed, rows deleted, tombstone, audit without content; retention sweep                                                                       |
| 17  | Failures visible, logged safely, retryable where appropriate                  | ✅                | job retry/backoff/dead-letter tests, admin retry, user regenerate/retry                                                                                                  |
| 18  | New developer can run locally from README + `.env.example`                    | 🟡                | Native path verified in this environment; Docker path not run here                                                                                                       |

## Externally blocked (needs your action)

1. ⛔ **Meeting-bot provider selection and adapter** — choose a provider against the checklist in
   `docs/PROVIDERS.md §3`, then implement `MeetingBotProvider` for it. Until then production cannot
   record meetings (by design: the mock is refused).
2. ⛔ Google Cloud OAuth client, Calendar API, consent screen and (for production) Google
   verification of the calendar scope.
3. ⛔ Microsoft Entra app registration, Graph delegated permissions, admin consent where required.
4. ⛔ Deepgram (or other STT) and Anthropic API keys, then the verification steps in PROVIDERS.md.
5. ⛔ Hosting decision, domain + TLS, managed PostgreSQL/Redis/S3, secrets manager.
6. ⛔ Legal/product: final privacy notice and recording policy text (in-app page is a draft),
   retention period (default 90 days), DPAs, recording-consent review per jurisdiction.
7. ⛔ Docker image build verification (blocked here; runs in CI).

## Follow-ups (not required for the MVP baseline, or decided with the product owner)

- ⏳ Browser end-to-end tests (Playwright) against the compose stack. The API-level pipeline tests
  and component tests cover the flows; no browser download was possible in this environment.
- ⏳ Calendar push notifications (Google watch channels / Graph subscriptions) to replace polling.
- ⏳ One bot shared by several users in the same meeting (privacy design needed).
- ⏳ Workspaces / sharing (explicitly out of the MVP; ownership checks are centralized).
- ⏳ Load test to confirm the p95 < 500 ms dashboard target under an agreed load profile
  (queries are indexed and paginated; no load test was run).
- ⏳ Separate PostgreSQL role for workers (instead of the `app.system` flag) for defence in depth.
- ⏳ Account deletion self-service (meeting deletion exists; account deletion is via an administrator).
- ⏳ Time-limited, audited support access to content (BRD 4.2) — intentionally not built; admins
  have no content access at all.
