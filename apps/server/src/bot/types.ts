import type { Readable } from "node:stream";
import type { Platform } from "@notetaker/shared";

/**
 * Meeting-bot provider adapter (FR-04). Core business logic depends only on this
 * interface, so a provider can be replaced without rewriting the pipeline.
 *
 * Implementations MUST NOT attempt to bypass waiting rooms, lobbies, guest restrictions,
 * host controls, tenant policies or consent requirements.
 */
export interface MeetingBotProvider {
  readonly name: string;
  /** True only for the development mock. Production config refuses mock providers. */
  readonly isMock: boolean;
  supportsPlatform(platform: Platform): boolean;

  createSession(input: CreateSessionInput): Promise<{ sessionId: string }>;
  getSession(sessionId: string): Promise<ProviderSessionState>;
  cancelSession(sessionId: string): Promise<void>;
  /** Returns the recording asset if the provider has finished producing it. */
  getRecording(sessionId: string): Promise<RecordingAssetResult>;
  /**
   * Authenticates and parses a webhook delivery. MUST verify the signature and timestamp
   * and throw `WebhookVerificationError` on any failure. Returns normalized events.
   */
  verifyAndParseWebhook(rawBody: Buffer, headers: Record<string, string | undefined>, now: Date): ProviderEvent[];
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}

export interface CreateSessionInput {
  meetingId: string;
  meetingUrl: string;
  platform: Platform;
  joinAt: Date;
  botName: string;
  /** Webhook URL the provider should call for this session. */
  webhookUrl: string;
  /** Dev-only scenario hint used by the mock provider. Ignored by real providers. */
  mockScenario?: string | null;
}

export type ProviderSessionStatus =
  | "scheduled"
  | "joining"
  | "waiting_for_admission"
  | "in_call_recording"
  | "call_ended"
  | "done"
  | "failed"
  | "cancelled";

export interface ProviderSessionState {
  status: ProviderSessionStatus;
  errorCode?: string | null;
  startedAt?: Date | null;
  endedAt?: Date | null;
}

export type RecordingAssetResult =
  | { status: "processing" }
  | { status: "unavailable"; errorCode: string }
  | {
      status: "ready";
      providerAssetId: string;
      mimeType: string;
      expectedSizeBytes?: number | null;
      recordedAt?: Date | null;
      /** Opens a download stream (provider credentials stay inside the adapter). */
      open(): Promise<Readable>;
    };

export type ProviderEventType =
  | "bot.joining"
  | "bot.waiting_for_admission"
  | "bot.in_call_recording"
  | "bot.call_ended"
  | "bot.recording_ready"
  | "bot.failed"
  | "bot.participant_joined";

export interface ProviderEvent {
  /** Provider-unique delivery/event id used for replay & duplicate protection. */
  eventId: string;
  type: ProviderEventType;
  sessionId: string;
  occurredAt: Date;
  errorCode?: string | null;
  participant?: { id: string; name: string } | null;
}

export class WebhookVerificationError extends Error {
  constructor(public readonly reason: "missing_headers" | "bad_signature" | "stale" | "malformed") {
    super(`Webhook verification failed: ${reason}`);
    this.name = "WebhookVerificationError";
  }
}

/** Provider error codes are normalized to this safe set before storage/display. */
export const PROVIDER_FAILURE_CODES = new Set([
  "bot_admission_timeout",
  "bot_denied_admission",
  "bot_join_failed",
  "meeting_requires_password",
  "meeting_not_found",
  "unsupported_platform",
  "recording_unavailable",
  "provider_error",
]);

export function normalizeFailureCode(code: string | null | undefined): string {
  return code && PROVIDER_FAILURE_CODES.has(code) ? code : "provider_error";
}
