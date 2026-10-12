import { detectMeetingUrl, findMeetingUrlInText } from "@notetaker/shared";
import { ProviderError } from "../lib/errors";
import { ReauthRequiredError } from "../auth/oauth";
import { CursorExpiredError, type CalendarApi, type ChangesResult, type NormalizedEvent } from "./types";

interface GoogleEvent {
  id: string;
  etag?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{ email?: string; displayName?: string; organizer?: boolean; self?: boolean; resource?: boolean }>;
}

/**
 * Google Calendar API v3 adapter (events.list with incremental sync tokens).
 * STATUS: implemented against Google's documented API; verified only with recorded-shape
 * fixtures in tests, not against a live account in this repository.
 */
export class GoogleCalendarApi implements CalendarApi {
  readonly provider = "google_calendar" as const;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = "https://www.googleapis.com/calendar/v3",
  ) {}

  async listChanges(opts: {
    accessToken: string;
    cursor: string | null;
    windowStart: Date;
    windowEnd: Date;
    maxPages?: number;
  }): Promise<ChangesResult> {
    const events: NormalizedEvent[] = [];
    let pageToken: string | undefined;
    let nextSyncToken: string | null = null;
    const maxPages = opts.maxPages ?? 50;

    for (let page = 0; page < maxPages; page++) {
      const p = new URLSearchParams({ singleEvents: "true", maxResults: "250", showDeleted: "true" });
      if (opts.cursor) p.set("syncToken", opts.cursor);
      else {
        p.set("timeMin", opts.windowStart.toISOString());
        p.set("timeMax", opts.windowEnd.toISOString());
      }
      if (pageToken) p.set("pageToken", pageToken);

      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/calendars/primary/events?${p.toString()}`, {
          headers: { Authorization: `Bearer ${opts.accessToken}`, Accept: "application/json" },
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw new ProviderError("calendar_sync_failed", "Google Calendar unreachable", true);
      }
      if (res.status === 410) throw new CursorExpiredError();
      if (res.status === 401) throw new ReauthRequiredError();
      if (res.status === 429 || res.status === 403 || res.status >= 500) {
        // 403 is Google's rateLimitExceeded/userRateLimitExceeded (and also insufficient scope).
        const body = (await res.json().catch(() => ({}))) as { error?: { errors?: Array<{ reason?: string }> } };
        const reason = body.error?.errors?.[0]?.reason ?? "";
        if (res.status === 403 && !/rateLimit/i.test(reason)) throw new ReauthRequiredError();
        throw new ProviderError("calendar_rate_limited", `Google Calendar HTTP ${res.status}`, true, res.status);
      }
      if (!res.ok) throw new ProviderError("calendar_sync_failed", `Google Calendar HTTP ${res.status}`, false, res.status);

      const body = (await res.json()) as { items?: GoogleEvent[]; nextPageToken?: string; nextSyncToken?: string };
      for (const item of body.items ?? []) events.push(normalizeGoogleEvent(item));
      if (body.nextPageToken) {
        pageToken = body.nextPageToken;
        continue;
      }
      nextSyncToken = body.nextSyncToken ?? null;
      break;
    }
    return { events, nextCursor: nextSyncToken };
  }
}

export function normalizeGoogleEvent(e: GoogleEvent): NormalizedEvent {
  const isAllDay = !!e.start?.date && !e.start?.dateTime;
  const videoEntry = e.conferenceData?.entryPoints?.find((ep) => ep.entryPointType === "video")?.uri;
  const meeting =
    detectMeetingUrl(e.hangoutLink) ??
    detectMeetingUrl(videoEntry) ??
    detectMeetingUrl(e.location) ??
    findMeetingUrlInText(e.location) ??
    findMeetingUrlInText(e.description);
  return {
    providerEventId: e.id,
    version: e.etag ?? null,
    cancelled: e.status === "cancelled",
    title: (e.summary ?? "Untitled meeting").slice(0, 300),
    start: e.start?.dateTime ? new Date(e.start.dateTime) : null,
    end: e.end?.dateTime ? new Date(e.end.dateTime) : null,
    isAllDay,
    meeting,
    attendees: (e.attendees ?? [])
      .filter((a) => !a.resource && (a.email || a.displayName))
      .slice(0, 200)
      .map((a) => ({
        key: (a.email ?? a.displayName ?? "").toLowerCase(),
        name: a.displayName ?? a.email ?? "Unknown",
        email: a.email ?? null,
        type: a.organizer ? ("organizer" as const) : ("attendee" as const),
      })),
  };
}
