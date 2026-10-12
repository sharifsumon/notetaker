import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () =>
  uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () => ts("updated_at").notNull().defaultNow();

// ---------------------------------------------------------------- accounts
export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email"),
    emailVerified: boolean("email_verified").notNull().default(false),
    displayName: text("display_name").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    role: text("role", { enum: ["user", "admin"] })
      .notNull()
      .default("user"),
    /** null = user has not made an explicit choice yet (onboarding). */
    autoRegister: boolean("auto_register"),
    recordingNoticeAcknowledgedAt: ts("recording_notice_acknowledged_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [index("users_email_idx").on(sql`lower(${t.email})`)],
);

export const authIdentities = pgTable(
  "auth_identities",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: ["google", "microsoft", "dev"] }).notNull(),
    providerSubject: text("provider_subject").notNull(),
    providerTenant: text("provider_tenant"),
    emailAtProvider: text("email_at_provider"),
    emailVerified: boolean("email_verified").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("auth_identities_provider_subject_uq").on(t.provider, t.providerSubject),
    index("auth_identities_user_idx").on(t.userId),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    csrfToken: text("csrf_token").notNull(),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [
    uniqueIndex("sessions_token_hash_uq").on(t.tokenHash),
    index("sessions_user_idx").on(t.userId),
  ],
);

// ---------------------------------------------------------------- calendars
export const calendarConnections = pgTable(
  "calendar_connections",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: ["google_calendar", "microsoft_calendar"] }).notNull(),
    accountSubject: text("account_subject").notNull(),
    accountEmail: text("account_email"),
    encryptedRefreshToken: text("encrypted_refresh_token"),
    encryptedAccessToken: text("encrypted_access_token"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Provider sync cursor: Google syncToken or Microsoft deltaLink (encrypted is unnecessary; not a credential). */
    syncState: jsonb("sync_state").$type<{
      cursor?: string;
      windowStart?: string;
      windowEnd?: string;
    }>(),
    status: text("status", { enum: ["active", "reconnect_required", "error", "disconnected"] })
      .notNull()
      .default("active"),
    syncInProgress: boolean("sync_in_progress").notNull().default(false),
    lastSyncedAt: ts("last_synced_at"),
    lastErrorCode: text("last_error_code"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("calendar_connections_account_uq").on(t.userId, t.provider, t.accountSubject),
    index("calendar_connections_status_idx").on(t.status),
  ],
);

// ---------------------------------------------------------------- meetings
export const meetings = pgTable(
  "meetings",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    calendarConnectionId: uuid("calendar_connection_id").references(() => calendarConnections.id, {
      onDelete: "set null",
    }),
    providerEventId: text("provider_event_id"),
    providerEventVersion: text("provider_event_version"),
    title: text("title").notNull(),
    platform: text("platform", { enum: ["google_meet", "microsoft_teams"] }).notNull(),
    /** Encrypted at rest (sensitive). */
    encryptedMeetingUrl: text("encrypted_meeting_url"),
    /** HMAC of the normalized URL, for de-duplicating manual registrations. */
    meetingUrlHash: text("meeting_url_hash"),
    scheduledStartAt: ts("scheduled_start_at").notNull(),
    scheduledEndAt: ts("scheduled_end_at"),
    actualStartAt: ts("actual_start_at"),
    actualEndAt: ts("actual_end_at"),
    timezoneAtCreation: text("timezone_at_creation").notNull(),
    status: text("status").notNull().default("scheduled"),
    substatus: text("substatus"),
    botProvider: text("bot_provider"),
    providerSessionId: text("provider_session_id"),
    registrationSource: text("registration_source", { enum: ["manual", "auto"] }),
    registeredAt: ts("registered_at"),
    registeredBy: text("registered_by"),
    failureCode: text("failure_code"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [
    uniqueIndex("meetings_calendar_event_uq")
      .on(t.calendarConnectionId, t.providerEventId)
      .where(sql`${t.providerEventId} IS NOT NULL`),
    uniqueIndex("meetings_provider_session_uq")
      .on(t.botProvider, t.providerSessionId)
      .where(sql`${t.providerSessionId} IS NOT NULL`),
    uniqueIndex("meetings_manual_dedupe_uq")
      .on(t.userId, t.meetingUrlHash, t.scheduledStartAt)
      .where(sql`${t.calendarConnectionId} IS NULL AND ${t.deletedAt} IS NULL`),
    index("meetings_user_start_idx").on(t.userId, t.scheduledStartAt),
    index("meetings_user_status_idx").on(t.userId, t.status),
    index("meetings_user_platform_idx").on(t.userId, t.platform),
    index("meetings_status_start_idx").on(t.status, t.scheduledStartAt),
  ],
);

export const meetingParticipants = pgTable(
  "meeting_participants",
  {
    id: id(),
    userId: uuid("user_id").notNull(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    email: text("email"),
    source: text("source", { enum: ["calendar", "provider"] }).notNull(),
    sourceKey: text("source_key").notNull(),
    participantType: text("participant_type"),
    joinedAt: ts("joined_at"),
    leftAt: ts("left_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("meeting_participants_uq").on(t.meetingId, t.source, t.sourceKey)],
);

export const recordings = pgTable(
  "recordings",
  {
    id: id(),
    userId: uuid("user_id").notNull(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    storageProvider: text("storage_provider").notNull(),
    storageKey: text("storage_key"),
    mimeType: text("mime_type"),
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }),
    durationSeconds: integer("duration_seconds"),
    checksumSha256: text("checksum_sha256"),
    status: text("status").notNull().default("pending"),
    errorCode: text("error_code"),
    providerAssetId: text("provider_asset_id"),
    recordedAt: ts("recorded_at"),
    storedAt: ts("stored_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("recordings_meeting_uq").on(t.meetingId)],
);

export interface StoredSegment {
  startMs: number | null;
  endMs: number | null;
  speaker: string | null;
  text: string;
}

export const transcripts = pgTable(
  "transcripts",
  {
    id: id(),
    userId: uuid("user_id").notNull(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    recordingId: uuid("recording_id")
      .notNull()
      .references(() => recordings.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    language: text("language"),
    provider: text("provider"),
    model: text("model"),
    text: text("text"),
    segments: jsonb("segments").$type<StoredSegment[]>(),
    wordCount: integer("word_count"),
    quality: text("quality", { enum: ["ok", "insufficient"] }),
    isMock: boolean("is_mock").notNull().default(false),
    rawOutput: jsonb("raw_output"),
    errorCode: text("error_code"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("transcripts_recording_uq").on(t.recordingId),
    index("transcripts_meeting_idx").on(t.meetingId),
  ],
);

export const meetingArtifacts = pgTable(
  "meeting_artifacts",
  {
    id: id(),
    userId: uuid("user_id").notNull(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    transcriptId: uuid("transcript_id").references(() => transcripts.id, { onDelete: "set null" }),
    artifactType: text("artifact_type", { enum: ["summary", "minutes"] }).notNull(),
    version: integer("version").notNull(),
    status: text("status").notNull().default("pending"),
    content: jsonb("content"),
    renderedText: text("rendered_text"),
    provider: text("provider"),
    model: text("model"),
    promptVersion: text("prompt_version"),
    usage: jsonb("usage").$type<{ inputTokens?: number; outputTokens?: number; calls?: number }>(),
    isMock: boolean("is_mock").notNull().default(false),
    generatedAt: ts("generated_at"),
    createdBy: text("created_by", { enum: ["system", "user"] }).notNull(),
    errorCode: text("error_code"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("meeting_artifacts_version_uq").on(t.meetingId, t.artifactType, t.version),
    index("meeting_artifacts_lookup_idx").on(t.meetingId, t.artifactType, t.version),
  ],
);

export const meetingStatusEvents = pgTable(
  "meeting_status_events",
  {
    id: id(),
    userId: uuid("user_id").notNull(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    oldStatus: text("old_status"),
    newStatus: text("new_status").notNull(),
    source: text("source").notNull(),
    reasonCode: text("reason_code"),
    safeMetadata: jsonb("safe_metadata").$type<Record<string, unknown>>(),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
  },
  (t) => [index("meeting_status_events_meeting_idx").on(t.meetingId, t.occurredAt)],
);

// ---------------------------------------------------------------- system tables
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: id(),
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    sessionId: text("session_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    receivedAt: ts("received_at").notNull().defaultNow(),
    processedAt: ts("processed_at"),
    outcome: text("outcome"),
  },
  (t) => [uniqueIndex("webhook_events_provider_event_uq").on(t.provider, t.eventId)],
);

export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    type: text("type").notNull(),
    entityId: text("entity_id"),
    userId: uuid("user_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status", {
      enum: ["pending", "queued", "running", "succeeded", "failed", "cancelled"],
    })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    runAt: ts("run_at").notNull().defaultNow(),
    nextRetryAt: ts("next_retry_at"),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: ts("completed_at"),
  },
  (t) => [
    uniqueIndex("jobs_idempotency_uq").on(t.idempotencyKey),
    index("jobs_dispatch_idx").on(t.status, t.runAt),
    index("jobs_entity_idx").on(t.type, t.entityId),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    actorType: text("actor_type", { enum: ["user", "admin", "system", "provider"] }).notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    correlationId: text("correlation_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
  },
  (t) => [
    index("audit_events_target_idx").on(t.targetType, t.targetId),
    index("audit_events_time_idx").on(t.occurredAt),
  ],
);

export type User = typeof users.$inferSelect;
export type Meeting = typeof meetings.$inferSelect;
export type CalendarConnectionRow = typeof calendarConnections.$inferSelect;
export type RecordingRow = typeof recordings.$inferSelect;
export type TranscriptRow = typeof transcripts.$inferSelect;
export type ArtifactRow = typeof meetingArtifacts.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
