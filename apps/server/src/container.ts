import { createHash } from "node:crypto";
import type { CalendarProvider, Platform } from "@notetaker/shared";
import { AnthropicLlmProvider } from "./ai/anthropic";
import { ArtifactService } from "./ai/artifact.service";
import { ArtifactGenerator } from "./ai/generator";
import { MockLlmProvider } from "./ai/mock-llm";
import type { LlmProvider } from "./ai/types";
import { AuditService } from "./audit/audit.service";
import { AuthService } from "./auth/auth.service";
import { OAuthClient, type IdentityProvider } from "./auth/oauth";
import { OAuthStateCodec } from "./auth/oauth-state";
import { SessionService } from "./auth/session.service";
import { BotService } from "./bot/bot.service";
import { MockMeetingBotProvider } from "./bot/mock-provider";
import type { MeetingBotProvider } from "./bot/types";
import { CalendarService } from "./calendar/calendar.service";
import { GoogleCalendarApi } from "./calendar/google";
import { MicrosoftCalendarApi } from "./calendar/microsoft";
import type { CalendarApi } from "./calendar/types";
import { webhookBaseUrl, type Env } from "./config/env";
import { Db } from "./db/client";
import { DeletionService } from "./deletion/deletion.service";
import { JobService } from "./jobs/job.service";
import { JobRunner, type HandlerMap } from "./jobs/runner";
import { TokenCipher } from "./lib/crypto";
import type { Logger } from "./lib/logger";
import { MeetingService } from "./meetings/meeting.service";
import { createMetrics, type Metrics } from "./metrics";
import { RecordingIngestService } from "./recordings/ingest.service";
import { MediaTools } from "./recordings/media";
import { LocalStorageAdapter } from "./storage/local";
import { S3StorageAdapter } from "./storage/s3";
import type { StorageAdapter } from "./storage/types";
import { DeepgramTranscriptionProvider } from "./transcription/deepgram";
import { MockTranscriptionProvider } from "./transcription/mock";
import { TranscriptionService } from "./transcription/transcription.service";
import type { TranscriptionProvider } from "./transcription/types";

export interface Overrides {
  db?: Db;
  bot?: MeetingBotProvider | null;
  stt?: TranscriptionProvider | null;
  llm?: LlmProvider | null;
  storage?: StorageAdapter;
  oauth?: Partial<Record<IdentityProvider, OAuthClient>>;
  calendarApis?: Partial<Record<CalendarProvider, CalendarApi>>;
  emitMockWebhooks?: boolean;
  metrics?: Metrics;
}

/**
 * Composition root: wires configuration, providers and services (dependency injection).
 * External providers are chosen by configuration and can be overridden in tests.
 */
export function createContainer(env: Env, logger: Logger, o: Overrides = {}) {
  const metrics = o.metrics ?? createMetrics();
  const db = o.db ?? new Db(env.DATABASE_URL, env.DATABASE_POOL_MAX);
  const cipher = new TokenCipher(env.TOKEN_ENCRYPTION_KEYS, env.TOKEN_ENCRYPTION_ACTIVE_KEY);
  const urlHashKey = createHash("sha256").update(`meeting-url:${env.SESSION_SECRET}`).digest("hex");
  const audit = new AuditService(logger);
  const jobs = new JobService(env.JOB_MAX_ATTEMPTS);

  const storage: StorageAdapter =
    o.storage ??
    (env.STORAGE_DRIVER === "s3"
      ? new S3StorageAdapter({
          bucket: env.S3_BUCKET!,
          region: env.S3_REGION!,
          endpoint: env.S3_ENDPOINT,
          forcePathStyle: env.S3_FORCE_PATH_STYLE,
          sse: env.S3_SSE,
          kmsKeyId: env.S3_KMS_KEY_ID,
        })
      : new LocalStorageAdapter(env.STORAGE_LOCAL_DIR));

  let bot: MeetingBotProvider | null;
  if (o.bot !== undefined) bot = o.bot;
  else if (env.MEETING_BOT_PROVIDER === "mock") {
    const mock = new MockMeetingBotProvider({
      webhookSecret: env.MOCK_BOT_WEBHOOK_SECRET!,
      stepMs: env.MOCK_BOT_STEP_MS,
      ffmpegPath: env.FFMPEG_PATH,
      logger,
      emitWebhooks: o.emitMockWebhooks ?? true,
    });
    mock.toleranceSec = env.WEBHOOK_TOLERANCE_SECONDS;
    bot = mock;
  } else bot = null;

  const stt: TranscriptionProvider | null =
    o.stt !== undefined
      ? o.stt
      : env.STT_PROVIDER === "mock"
        ? new MockTranscriptionProvider()
        : env.STT_PROVIDER === "deepgram"
          ? new DeepgramTranscriptionProvider(env.DEEPGRAM_API_KEY!, env.DEEPGRAM_MODEL)
          : null;

  const llm: LlmProvider | null =
    o.llm !== undefined
      ? o.llm
      : env.LLM_PROVIDER === "mock"
        ? new MockLlmProvider()
        : env.LLM_PROVIDER === "anthropic"
          ? new AnthropicLlmProvider(env.ANTHROPIC_API_KEY!, env.LLM_MODEL)
          : null;

  const oauth: Partial<Record<IdentityProvider, OAuthClient>> = o.oauth ?? {};
  if (!o.oauth) {
    if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
      oauth.google = new OAuthClient("google", { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET });
    }
    if (env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET) {
      oauth.microsoft = new OAuthClient("microsoft", {
        clientId: env.MICROSOFT_CLIENT_ID,
        clientSecret: env.MICROSOFT_CLIENT_SECRET,
        tenant: env.MICROSOFT_TENANT,
      });
    }
  }
  const calendarApis: Partial<Record<CalendarProvider, CalendarApi>> = o.calendarApis ?? {
    ...(oauth.google ? { google_calendar: new GoogleCalendarApi() } : {}),
    ...(oauth.microsoft ? { microsoft_calendar: new MicrosoftCalendarApi() } : {}),
  };

  const meetings = new MeetingService({
    db,
    jobs,
    audit,
    cipher,
    urlHashKey,
    botConfigured: () => bot !== null,
    botSupports: (p: Platform) => bot?.supportsPlatform(p) ?? false,
    joinLeadMinutes: env.BOT_JOIN_LEAD_MINUTES,
  });
  const botService = new BotService({
    db,
    provider: bot,
    meetings,
    jobs,
    audit,
    logger,
    metrics,
    webhookUrl: (p) => `${webhookBaseUrl(env)}/api/v1/webhooks/meeting-provider/${p}`,
    botNameTemplate: env.MEETING_BOT_NAME_TEMPLATE,
    reconcileGraceMinutes: env.BOT_RECONCILE_GRACE_MINUTES,
  });
  const media = new MediaTools(env.FFMPEG_PATH, env.FFPROBE_PATH);
  const ingest = new RecordingIngestService({
    db,
    provider: bot,
    storage,
    media,
    meetings,
    jobs,
    audit,
    logger,
    maxBytes: env.RECORDING_MAX_BYTES,
    maxDurationSeconds: env.RECORDING_MAX_DURATION_SECONDS,
  });
  const generator = llm
    ? new ArtifactGenerator(llm, {
        chunkChars: env.LLM_CHUNK_CHARS,
        maxTranscriptChars: env.LLM_MAX_TRANSCRIPT_CHARS,
        maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
      })
    : null;
  const artifacts = new ArtifactService({ db, jobs, audit, metrics, llm, generator });
  const transcription = new TranscriptionService({
    db,
    stt,
    storage,
    artifacts,
    minWords: env.MIN_TRANSCRIPT_WORDS,
    language: env.STT_LANGUAGE,
    autoSummary: env.AUTO_GENERATE_SUMMARY,
    autoMinutes: env.AUTO_GENERATE_MINUTES,
  });
  const calendar = new CalendarService({
    db,
    cipher,
    jobs,
    audit,
    meetings,
    logger,
    oauth,
    apis: calendarApis,
    pastDays: env.CALENDAR_SYNC_PAST_DAYS,
    futureDays: env.CALENDAR_SYNC_FUTURE_DAYS,
    syncIntervalMinutes: env.CALENDAR_SYNC_INTERVAL_MINUTES,
  });
  const deletion = new DeletionService({
    db,
    storage,
    provider: bot,
    meetings,
    jobs,
    audit,
    logger,
    retentionDays: env.RETENTION_DAYS,
  });

  const handlers: HandlerMap = {
    calendar_sync: { run: async (j) => void (await calendar.sync(j.entityId!)) },
    bot_schedule: {
      run: (j) => botService.schedule(j.entityId!),
      onFinalFailure: (j, code) => botService.markScheduleFailed(j.entityId!, code),
    },
    bot_cancel: { run: (j) => botService.cancel(String(j.payload.sessionId)) },
    recording_ingest: {
      run: (j) => ingest.ingest(j.entityId!),
      onFinalFailure: (j, code) =>
        ingest.fail({ id: j.entityId! }, code === "storage_error" ? "storage_error" : code === "recording_not_ready" ? "recording_unavailable" : "recording_invalid"),
    },
    transcribe: {
      run: (j) => transcription.transcribe(j.entityId!),
      onFinalFailure: (j) => transcription.markFailed(j.entityId!, "transcription_failed"),
    },
    generate_summary: { run: (j) => artifacts.process(j.entityId!), onFinalFailure: (j, c) => artifacts.markFailed(j.entityId!, c) },
    generate_minutes: { run: (j) => artifacts.process(j.entityId!), onFinalFailure: (j, c) => artifacts.markFailed(j.entityId!, c) },
    meeting_delete: { run: (j) => deletion.deleteMeeting(j.entityId!, String(j.payload.reason ?? "user_request")) },
  };
  const runner = new JobRunner(db, jobs, handlers, logger, metrics);

  return {
    env,
    logger,
    metrics,
    db,
    cipher,
    audit,
    jobs,
    storage,
    bot,
    stt,
    llm,
    oauth,
    calendarApis,
    oauthState: new OAuthStateCodec(env.SESSION_SECRET),
    sessions: new SessionService(db, env.SESSION_TTL_HOURS, env.SESSION_IDLE_TIMEOUT_HOURS),
    auth: new AuthService(db, audit, env.DEFAULT_TIMEZONE),
    meetings,
    botService,
    ingest,
    transcription,
    artifacts,
    calendar,
    deletion,
    runner,
  };
}

export type Container = ReturnType<typeof createContainer>;
