# External providers: setup and remaining manual steps

Nothing in this repository has been verified against a live Google, Microsoft, meeting-bot,
Deepgram or Anthropic account (no credentials were available). Each adapter is implemented against
the provider's documented API and covered by tests with recorded-shape fixtures or doubles. Treat
each section below as **blocked until someone completes it and runs the verification step**.

## 1. Google: sign-in and Google Calendar

1. Create a Google Cloud project and an **OAuth client ID** of type _Web application_.
2. Authorized redirect URIs (replace the origin with your `PUBLIC_URL`):
   - `https://notes.example.com/api/v1/auth/google/callback` (sign-in)
   - `https://notes.example.com/api/v1/calendar-connections/google_calendar/callback` (calendar)
   - For local development: the same paths on `http://localhost:5173`.
3. Enable the **Google Calendar API**.
4. Configure the OAuth consent screen. Scopes requested by the app:
   - sign-in: `openid email profile`
   - calendar (separate consent): `openid email https://www.googleapis.com/auth/calendar.events.readonly`
5. Calendar read scopes are classified by Google as sensitive; a public production app normally needs
   Google's OAuth app verification. Plan time for it. While unverified, only test users you add can
   connect calendars.
6. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

**Verify:** sign in with Google; connect Google Calendar in Settings; confirm a test event with a
Meet link appears; reschedule and cancel it and confirm the dashboard follows; revoke access at
myaccount.google.com/permissions and confirm the connection shows "Reconnect needed" after the next
sync.

## 2. Microsoft: sign-in and Outlook Calendar

1. In Microsoft Entra ID, create an **app registration** (choose supported account types to match
   `MICROSOFT_TENANT`: `common`, `organizations`, `consumers` or a single tenant id).
2. Platform _Web_, redirect URIs:
   - `https://notes.example.com/api/v1/auth/microsoft/callback`
   - `https://notes.example.com/api/v1/calendar-connections/microsoft_calendar/callback`
3. Create a client secret (record its expiry and rotate before it lapses).
4. Delegated Microsoft Graph permissions: `openid`, `email`, `profile`, `offline_access`,
   `Calendars.Read`.
5. Some organizations require **admin consent** for third-party apps; users in those tenants will see
   an approval prompt their admin must complete. Publisher verification may be required for
   multi-tenant production use.
6. Set `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT`.

**Verify:** as Google above. Also confirm that a Teams meeting's join link is detected (the adapter
reads `onlineMeeting.joinUrl`, falling back to the location/body preview). If Graph's
`calendarView/delta` response in your tenant omits `onlineMeeting`, report it: the fallback may then
need a follow-up `GET /me/events/{id}?$select=onlineMeeting`.

Microsoft has no per-token revocation endpoint; disconnecting deletes tokens locally. Users can
remove the app's consent at myapps.microsoft.com.

## 3. Meeting-bot provider (BLOCKED: provider not selected)

The app ships only a development mock (`MEETING_BOT_PROVIDER=mock`, refused in production). Before
choosing a provider, confirm in writing with the vendor:

| Check                                                                                      | Why it matters |
| ------------------------------------------------------------------------------------------ | -------------- |
| Google Meet and Microsoft Teams support for your users' account types and tenants          | BRD FR-04      |
| The bot waits in lobbies and never bypasses host admission, tenant or guest policies       | BRD 5.2, 12    |
| Audio-only (or audio extraction) output; format, size, retention on the vendor side        | FR-05          |
| Webhook signing scheme, timestamp/replay protection, retry behaviour                       | FR-04          |
| Scheduling a join time; cancelling a scheduled bot; deleting recordings on the vendor side | FR-03, FR-14   |
| Bot display name customization and in-meeting recording notice                             | consent        |
| Data residency, sub-processors, DPA, pricing                                               | BRD 1, 16      |

To add the chosen provider:

1. Create `apps/server/src/bot/<vendor>-provider.ts` implementing `MeetingBotProvider`:
   - `createSession` with `joinAt`, `botName`, `webhookUrl` (pass the meeting id as metadata and use
     the vendor's idempotency key if offered, so a retried job cannot create a second bot);
   - `getSession`, `cancelSession`, `getRecording` (return `processing` while the asset is not ready);
   - `verifyAndParseWebhook`: verify the vendor signature and timestamp, map vendor events to the
     normalized `ProviderEvent` types and vendor error codes to `PROVIDER_FAILURE_CODES`.
2. Add the provider name to `MEETING_BOT_PROVIDER` and its credentials to `config/env.ts` and
   `.env.example`; wire it in `container.ts`.
3. Write adapter tests with recorded vendor payloads (signature valid/invalid/stale, each event type).
4. Configure the vendor's webhook URL: `${WEBHOOK_PUBLIC_URL}/api/v1/webhooks/meeting-provider/<name>`.
5. Verify in a sandbox meeting: lobby admission, denial, host ending the call, bot removed mid-call.

## 4. Speech-to-text (Deepgram adapter implemented, unverified)

1. Create a Deepgram project and API key. Set `STT_PROVIDER=deepgram`, `DEEPGRAM_API_KEY`,
   optionally `DEEPGRAM_MODEL` and `STT_LANGUAGE`.
2. Confirm language support for your meetings (for example Bengali if relevant) and data-retention
   settings on the Deepgram side.

**Verify:** record a test meeting with two speakers; confirm transcript segments, timestamps and
diarized speaker labels appear, and that silence produces "No speech was detected".

Another STT service can be added by implementing `TranscriptionProvider`.

## 5. AI generation (Anthropic adapter implemented, unverified)

1. Create an API key in the Claude Console. Set `LLM_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, and
   `LLM_MODEL` (default `claude-sonnet-5-5`; confirm current model ids in the Anthropic docs).
2. The adapter uses JSON structured outputs (`output_config.format`) and re-validates the response.

**Verify:** generate summary and minutes for the test meeting; check owners/dates that were not said
show as "Not specified"; run a transcript containing an instruction such as "ignore your rules" and
confirm it is treated as content. Check token usage stored on `meeting_artifacts.usage`.

## 6. Storage

Production with more than one server should use S3-compatible storage:
`STORAGE_DRIVER=s3`, a private bucket with **Block Public Access**, default encryption (SSE-S3 or
SSE-KMS → `S3_SSE`, `S3_KMS_KEY_ID`), and IAM credentials limited to `s3:GetObject`, `s3:PutObject`,
`s3:DeleteObject`, `s3:ListBucket` on that bucket. Credentials come from the standard AWS provider
chain (instance role / environment). For a single server, `STORAGE_DRIVER=local` on an encrypted
volume is acceptable.

## 7. Domain, HTTPS and legal prerequisites

- A domain with TLS terminating at the load balancer/ingress; `PUBLIC_URL=https://…`,
  `COOKIE_SECURE=true`, `TRUST_PROXY=1` (or the number of proxies).
- A public HTTPS URL reachable by the bot provider for webhooks (`WEBHOOK_PUBLIC_URL`). For local
  testing with a real provider, use a tunnel.
- Before launch (BRD release gates): final privacy notice and recording policy text (the in-app
  page is a draft), retention period (`RETENTION_DAYS`), data-processing agreements with each
  provider, and legal review of recording-consent requirements for every launch jurisdiction.
