export const RECORDING_STATUSES = ["pending", "processing", "ready", "failed", "deleted"] as const;
export type RecordingStatus = (typeof RECORDING_STATUSES)[number];

export const TRANSCRIPT_STATUSES = ["pending", "processing", "completed", "failed"] as const;
export type TranscriptStatus = (typeof TRANSCRIPT_STATUSES)[number];

export const ARTIFACT_STATUSES = ["pending", "processing", "completed", "failed"] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

export const ARTIFACT_TYPES = ["summary", "minutes"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

/** Availability shown in dashboard rows. `none` = nothing exists yet / not applicable. */
export type Availability = "none" | "processing" | "ready" | "failed";

export function availabilityFromStatus(
  status: RecordingStatus | TranscriptStatus | ArtifactStatus | null | undefined,
): Availability {
  switch (status) {
    case null:
    case undefined:
    case "deleted":
      return "none";
    case "pending":
    case "processing":
      return "processing";
    case "ready":
    case "completed":
      return "ready";
    case "failed":
      return "failed";
  }
}

/** Safe, user-facing error codes. Never include provider secrets or content. */
export const ERROR_MESSAGES: Record<string, string> = {
  bot_admission_timeout: "The recording bot was not admitted to the meeting before the timeout.",
  bot_denied_admission: "The host denied the recording bot entry to the meeting.",
  bot_join_failed: "The recording bot could not join the meeting.",
  meeting_requires_password: "The meeting requires a password the bot does not have.",
  meeting_not_found: "The meeting link could not be found by the recording provider.",
  unsupported_platform: "This meeting platform is not supported.",
  provider_error: "The recording provider reported an error.",
  provider_unavailable: "The recording provider is temporarily unavailable.",
  recording_unavailable: "No recording was produced for this meeting.",
  recording_invalid: "The recording file could not be validated.",
  recording_too_large: "The recording exceeds the configured size or duration limit.",
  storage_error: "The recording could not be stored.",
  transcript_empty: "No speech was detected in the recording.",
  transcript_unavailable: "A transcript is not available for this meeting.",
  transcript_insufficient: "The transcript is too short or unclear to produce reliable notes.",
  transcription_failed: "Transcription failed.",
  generation_failed: "AI generation failed.",
  generation_invalid_output: "The AI output did not match the required structure.",
  calendar_reconnect_required: "Calendar access was revoked or expired. Please reconnect.",
  calendar_sync_failed: "Calendar sync failed.",
  internal_error: "An unexpected error occurred.",
};

export function describeError(code: string | null | undefined): string | null {
  if (!code) return null;
  return ERROR_MESSAGES[code] ?? ERROR_MESSAGES.internal_error ?? null;
}
