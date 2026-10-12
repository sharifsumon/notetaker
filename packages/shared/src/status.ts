/**
 * Meeting lifecycle state machine (ADR-003 in docs/ARCHITECTURE.md).
 *
 * The meeting lifecycle ends at `completed` once the recording is validated and stored.
 * Transcript / summary / minutes progress is tracked by independent artifact statuses
 * (see artifacts.ts) so a failed AI step never marks a valid recording as failed.
 */
export const MEETING_STATUSES = [
  "scheduled",
  "queued",
  "joining",
  "in_progress",
  "recording_processing",
  "completed",
  "failed",
  "cancelled",
  "unsupported",
  "deletion_pending",
] as const;

export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const MEETING_STATUS_LABELS: Record<MeetingStatus, string> = {
  scheduled: "Scheduled",
  queued: "Queued",
  joining: "Joining",
  in_progress: "In progress",
  recording_processing: "Processing",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  unsupported: "Unsupported",
  deletion_pending: "Deletion pending",
};

/** Allowed transitions. Anything not listed is rejected. */
export const MEETING_TRANSITIONS: Record<MeetingStatus, readonly MeetingStatus[]> = {
  // Synced from calendar, not yet registered for recording.
  scheduled: ["queued", "cancelled", "unsupported", "deletion_pending"],
  // Registered; bot session requested or pending creation.
  queued: ["joining", "in_progress", "failed", "cancelled", "scheduled", "deletion_pending"],
  // Provider confirmed the bot is joining / waiting for admission.
  joining: ["in_progress", "failed", "cancelled", "deletion_pending"],
  // Provider confirmed the bot is in the call and recording.
  in_progress: ["recording_processing", "failed", "deletion_pending"],
  // Call ended; recording being transferred, validated and stored.
  recording_processing: ["completed", "failed", "deletion_pending"],
  completed: ["deletion_pending"],
  // A failed meeting can be retried: re-queued (before end) or ingestion retried.
  failed: ["queued", "recording_processing", "deletion_pending"],
  // A cancelled future meeting may be registered again.
  cancelled: ["queued", "scheduled", "deletion_pending"],
  unsupported: ["scheduled", "deletion_pending"],
  deletion_pending: [],
};

export function canTransition(from: MeetingStatus, to: MeetingStatus): boolean {
  return MEETING_TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: MeetingStatus,
    public readonly to: MeetingStatus,
  ) {
    super(`Invalid meeting status transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition(from: MeetingStatus, to: MeetingStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** Statuses in which a bot may still be cancelled by the user. */
export const CANCELLABLE_STATUSES: readonly MeetingStatus[] = ["queued", "joining"];
/** Statuses that represent an active provider session. */
export const ACTIVE_BOT_STATUSES: readonly MeetingStatus[] = ["queued", "joining", "in_progress"];

export const PLATFORMS = ["google_meet", "microsoft_teams"] as const;
export type Platform = (typeof PLATFORMS)[number];
export const PLATFORM_LABELS: Record<Platform, string> = {
  google_meet: "Google Meet",
  microsoft_teams: "Microsoft Teams",
};
