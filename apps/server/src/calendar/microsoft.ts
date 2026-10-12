import { detectMeetingUrl, findMeetingUrlInText } from "@notetaker/shared";
import { ProviderError } from "../lib/errors";
import { ReauthRequiredError } from "../auth/oauth";
import {
  CursorExpiredError,
  type CalendarApi,
  type ChangesResult,
  type NormalizedEvent,
} from "./types";

interface GraphEvent {
  id: string;
  changeKey?: string;
  subject?: string;
  isAllDay?: boolean;
  isCancelled?: boolean;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  onlineMeeting?: { joinUrl?: string } | null;
  onlineMeetingUrl?: string | null;
  location?: { displayName?: string };
  bodyPreview?: string;
  organizer?: { emailAddress?: { name?: string; address?: string } };
  attendees?: Array<{ type?: string; emailAddress?: { name?: string; address?: string } }>;
  "@removed"?: { reason?: string };
}

/** Graph returns dateTime without offset; with `Prefer: outlook.timezone="UTC"` it is UTC. */
function parseGraphDate(d?: { dateTime?: string; timeZone?: string }): Date | null {
  if (!d?.dateTime) return null;
  const hasOffset = /[zZ]|[+-]\d{2}:\d{2}$/.test(d.dateTime);
  const date = new Date(hasOffset ? d.dateTime : `${d.dateTime}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Microsoft Graph calendarView delta adapter.
 * STATUS: implemented against Microsoft Graph's documented delta query; verified only with
 * recorded-shape fixtures in tests, not against a live tenant in this repository.
 */
export class MicrosoftCalendarApi implements CalendarApi {
  readonly provider = "microsoft_calendar" as const;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = "https://graph.microsoft.com/v1.0",
  ) {}

  async listChanges(opts: {
    accessToken: string;
    cursor: string | null;
    windowStart: Date;
    windowEnd: Date;
    maxPages?: number;
  }): Promise<ChangesResult> {
    const events: NormalizedEvent[] = [];
    let url: string | null =
      opts.cursor ??
      `${this.baseUrl}/me/calendarView/delta?${new URLSearchParams({
        startDateTime: opts.windowStart.toISOString(),
        endDateTime: opts.windowEnd.toISOString(),
      }).toString()}`;
    // Only follow links on the Graph host (never send the token elsewhere).
    const allowedHost = new URL(this.baseUrl).host;
    let deltaLink: string | null = null;
    const maxPages = opts.maxPages ?? 50;

    for (let page = 0; page < maxPages && url; page++) {
      if (new URL(url).host !== allowedHost)
        throw new ProviderError("calendar_sync_failed", "Unexpected Graph link host", false);
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          headers: {
            Authorization: `Bearer ${opts.accessToken}`,
            Accept: "application/json",
            Prefer: 'odata.maxpagesize=50, outlook.timezone="UTC"',
          },
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw new ProviderError("calendar_sync_failed", "Microsoft Graph unreachable", true);
      }
      if (res.status === 410) throw new CursorExpiredError();
      if (res.status === 401 || res.status === 403) throw new ReauthRequiredError();
      if (res.status === 429 || res.status >= 500) {
        throw new ProviderError(
          "calendar_rate_limited",
          `Microsoft Graph HTTP ${res.status}`,
          true,
          res.status,
        );
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
        if (body.error?.code === "SyncStateNotFound" || body.error?.code === "syncStateNotFound")
          throw new CursorExpiredError();
        throw new ProviderError(
          "calendar_sync_failed",
          `Microsoft Graph HTTP ${res.status}`,
          false,
          res.status,
        );
      }
      const body = (await res.json()) as {
        value?: GraphEvent[];
        "@odata.nextLink"?: string;
        "@odata.deltaLink"?: string;
      };
      for (const item of body.value ?? []) events.push(normalizeGraphEvent(item));
      url = body["@odata.nextLink"] ?? null;
      if (!url) deltaLink = body["@odata.deltaLink"] ?? null;
    }
    return { events, nextCursor: deltaLink };
  }
}

export function normalizeGraphEvent(e: GraphEvent): NormalizedEvent {
  const removed = !!e["@removed"];
  const meeting =
    detectMeetingUrl(e.onlineMeeting?.joinUrl) ??
    detectMeetingUrl(e.onlineMeetingUrl) ??
    findMeetingUrlInText(e.location?.displayName) ??
    findMeetingUrlInText(e.bodyPreview);
  const attendees = [
    ...(e.organizer?.emailAddress
      ? [{ type: "organizer" as const, emailAddress: e.organizer.emailAddress }]
      : []),
    ...(e.attendees ?? [])
      .filter((a) => a.type !== "resource")
      .map((a) => ({ type: "attendee" as const, emailAddress: a.emailAddress })),
  ];
  const seen = new Set<string>();
  return {
    providerEventId: e.id,
    version: e.changeKey ?? null,
    cancelled: removed || e.isCancelled === true,
    title: (e.subject ?? "Untitled meeting").slice(0, 300),
    start: parseGraphDate(e.start),
    end: parseGraphDate(e.end),
    isAllDay: e.isAllDay === true,
    meeting,
    attendees: attendees
      .filter((a) => a.emailAddress?.address || a.emailAddress?.name)
      .map((a) => ({
        key: (a.emailAddress?.address ?? a.emailAddress?.name ?? "").toLowerCase(),
        name: a.emailAddress?.name || a.emailAddress?.address || "Unknown",
        email: a.emailAddress?.address ?? null,
        type: a.type,
      }))
      .filter((a) => (seen.has(a.key) ? false : (seen.add(a.key), true)))
      .slice(0, 200),
  };
}
