import { z } from "zod";
import { MinutesContentSchema, SummaryContentSchema } from "./ai-schemas";
import { ARTIFACT_STATUSES, RECORDING_STATUSES, TRANSCRIPT_STATUSES } from "./artifacts";
import { MEETING_STATUSES, PLATFORMS } from "./status";

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const TimeZoneSchema = z.string().min(1).max(64).refine(isValidTimeZone, "Invalid IANA time zone");
const IsoDate = z.iso.datetime({ offset: true });
const Uuid = z.uuid();

export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
    details: z.unknown().optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

export const AvailabilitySchema = z.enum(["none", "processing", "ready", "failed"]);

// ---------- Account ----------
export const MeSchema = z.object({
  id: Uuid,
  email: z.string().nullable(),
  displayName: z.string(),
  timezone: z.string(),
  role: z.enum(["user", "admin"]),
  autoRegister: z.boolean().nullable(),
  recordingNoticeAcknowledgedAt: z.string().nullable(),
  identities: z.array(z.object({ provider: z.enum(["google", "microsoft", "dev"]), email: z.string().nullable() })),
  csrfToken: z.string(),
  features: z.object({
    devLogin: z.boolean(),
    googleAuth: z.boolean(),
    microsoftAuth: z.boolean(),
    mockProviders: z.boolean(),
  }),
});
export type Me = z.infer<typeof MeSchema>;

export const UpdateSettingsSchema = z
  .object({
    timezone: TimeZoneSchema.optional(),
    displayName: z.string().trim().min(1).max(120).optional(),
    autoRegister: z.boolean().optional(),
    acknowledgeRecordingNotice: z.literal(true).optional(),
  })
  .strict();
export type UpdateSettings = z.infer<typeof UpdateSettingsSchema>;

export const AuthConfigSchema = z.object({
  googleAuth: z.boolean(),
  microsoftAuth: z.boolean(),
  devLogin: z.boolean(),
});

// ---------- Calendar ----------
export const CALENDAR_PROVIDERS = ["google_calendar", "microsoft_calendar"] as const;
export type CalendarProvider = (typeof CALENDAR_PROVIDERS)[number];
export const CALENDAR_CONNECTION_STATUSES = ["active", "reconnect_required", "error", "disconnected"] as const;

export const CalendarConnectionSchema = z.object({
  id: Uuid,
  provider: z.enum(CALENDAR_PROVIDERS),
  status: z.enum(CALENDAR_CONNECTION_STATUSES),
  accountEmail: z.string().nullable(),
  scopes: z.array(z.string()),
  lastSyncedAt: z.string().nullable(),
  lastErrorCode: z.string().nullable(),
  syncInProgress: z.boolean(),
});
export type CalendarConnection = z.infer<typeof CalendarConnectionSchema>;

// ---------- Meetings ----------
export const MEETING_VIEWS = ["upcoming", "past", "all"] as const;

export const MeetingListQuerySchema = z
  .object({
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    platform: z.enum(PLATFORMS).optional(),
    status: z.enum(MEETING_STATUSES).optional(),
    q: z.string().trim().max(200).optional(),
    view: z.enum(MEETING_VIEWS).default("all"),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type MeetingListQuery = z.infer<typeof MeetingListQuerySchema>;

export const MeetingRowSchema = z.object({
  id: Uuid,
  title: z.string(),
  platform: z.enum(PLATFORMS),
  scheduledStartAt: z.string(),
  scheduledEndAt: z.string().nullable(),
  durationSeconds: z.number().nullable(),
  status: z.enum(MEETING_STATUSES),
  failureCode: z.string().nullable(),
  registrationSource: z.enum(["manual", "auto"]).nullable(),
  recording: AvailabilitySchema,
  transcript: AvailabilitySchema,
  summary: AvailabilitySchema,
  minutes: AvailabilitySchema,
  canRegister: z.boolean(),
  canCancel: z.boolean(),
});
export type MeetingRow = z.infer<typeof MeetingRowSchema>;

export const MeetingStatsSchema = z.object({
  total: z.number(),
  completed: z.number(),
  processing: z.number(),
  failed: z.number(),
});

export const MeetingListResponseSchema = z.object({
  items: z.array(MeetingRowSchema),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
  stats: MeetingStatsSchema,
});
export type MeetingListResponse = z.infer<typeof MeetingListResponseSchema>;

export const StatusEventSchema = z.object({
  from: z.enum(MEETING_STATUSES).nullable(),
  to: z.enum(MEETING_STATUSES),
  source: z.string(),
  reasonCode: z.string().nullable(),
  occurredAt: z.string(),
});

export const MeetingDetailSchema = MeetingRowSchema.extend({
  actualStartAt: z.string().nullable(),
  actualEndAt: z.string().nullable(),
  timezoneAtCreation: z.string(),
  failureMessage: z.string().nullable(),
  substatus: z.string().nullable(),
  participants: z.array(z.object({ displayName: z.string(), source: z.string() })),
  statusHistory: z.array(StatusEventSchema),
  fromCalendar: z.boolean(),
});
export type MeetingDetail = z.infer<typeof MeetingDetailSchema>;

export const RegisterMeetingSchema = z.union([
  z.object({ meetingId: Uuid }).strict(),
  z
    .object({
      title: z.string().trim().min(1).max(300),
      meetingUrl: z.string().trim().min(1).max(2048),
      startAt: IsoDate,
      endAt: IsoDate.optional(),
    })
    .strict(),
]);
export type RegisterMeeting = z.infer<typeof RegisterMeetingSchema>;

// ---------- Recording / transcript / artifacts ----------
export const RecordingSchema = z.object({
  status: z.enum(RECORDING_STATUSES).nullable(),
  mimeType: z.string().nullable(),
  durationSeconds: z.number().nullable(),
  fileSizeBytes: z.number().nullable(),
  streamUrl: z.string().nullable(),
  downloadUrl: z.string().nullable(),
  errorCode: z.string().nullable(),
});
export type Recording = z.infer<typeof RecordingSchema>;

export const TranscriptSegmentSchema = z.object({
  startMs: z.number().nullable(),
  endMs: z.number().nullable(),
  speaker: z.string().nullable(),
  text: z.string(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

export const TranscriptSchema = z.object({
  status: z.enum(TRANSCRIPT_STATUSES).nullable(),
  language: z.string().nullable(),
  provider: z.string().nullable(),
  segments: z.array(TranscriptSegmentSchema),
  totalSegments: z.number(),
  speakerLabelsVerified: z.literal(false),
  errorCode: z.string().nullable(),
  isMock: z.boolean(),
});
export type Transcript = z.infer<typeof TranscriptSchema>;

export const TranscriptQuerySchema = z
  .object({
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(2000).default(500),
  })
  .strict();

const artifactBase = {
  id: Uuid.nullable(),
  status: z.enum(ARTIFACT_STATUSES).nullable(),
  version: z.number().nullable(),
  renderedText: z.string().nullable(),
  generatedAt: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
  errorCode: z.string().nullable(),
  isMock: z.boolean(),
  canGenerate: z.boolean(),
};

export const SummaryArtifactSchema = z.object({ ...artifactBase, content: SummaryContentSchema.nullable() });
export type SummaryArtifact = z.infer<typeof SummaryArtifactSchema>;
export const MinutesArtifactSchema = z.object({ ...artifactBase, content: MinutesContentSchema.nullable() });
export type MinutesArtifact = z.infer<typeof MinutesArtifactSchema>;

export const GenerateArtifactSchema = z.object({ regenerate: z.boolean().default(false) }).strict();

// ---------- Admin ----------
export const AdminJobSchema = z.object({
  id: Uuid,
  type: z.string(),
  status: z.string(),
  attempts: z.number(),
  entityId: z.string().nullable(),
  errorCode: z.string().nullable(),
  runAt: z.string(),
  updatedAt: z.string(),
});
export type AdminJob = z.infer<typeof AdminJobSchema>;
