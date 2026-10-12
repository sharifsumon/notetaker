import type { CalendarProvider, DetectedMeeting } from "@notetaker/shared";

export interface NormalizedAttendee {
  key: string;
  name: string;
  email: string | null;
  type: "organizer" | "attendee";
}

export interface NormalizedEvent {
  providerEventId: string;
  version: string | null;
  cancelled: boolean;
  title: string;
  start: Date | null;
  end: Date | null;
  isAllDay: boolean;
  meeting: DetectedMeeting | null;
  attendees: NormalizedAttendee[];
}

export interface ChangesResult {
  events: NormalizedEvent[];
  nextCursor: string | null;
}

/** Thrown when an incremental cursor is no longer valid and a full resync is required. */
export class CursorExpiredError extends Error {
  constructor() {
    super("Sync cursor expired");
    this.name = "CursorExpiredError";
  }
}

/** Calendar API adapter (FR-02). Handles pagination internally. */
export interface CalendarApi {
  readonly provider: CalendarProvider;
  listChanges(opts: {
    accessToken: string;
    cursor: string | null;
    windowStart: Date;
    windowEnd: Date;
    maxPages?: number;
  }): Promise<ChangesResult>;
}
