import { describe, expect, it } from "vitest";
import { ReauthRequiredError } from "../auth/oauth";
import { GoogleCalendarApi, normalizeGoogleEvent } from "./google";
import { MicrosoftCalendarApi, normalizeGraphEvent } from "./microsoft";
import { CursorExpiredError } from "./types";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const win = {
  windowStart: new Date("2026-10-01T00:00:00Z"),
  windowEnd: new Date("2026-11-01T00:00:00Z"),
};

describe("Google Calendar adapter", () => {
  it("normalizes events and detects Meet links from conferenceData", () => {
    const e = normalizeGoogleEvent({
      id: "e1",
      etag: '"1"',
      summary: "Planning",
      start: { dateTime: "2026-10-12T09:00:00+06:00" },
      end: { dateTime: "2026-10-12T10:00:00+06:00" },
      conferenceData: {
        entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }],
      },
      attendees: [
        { email: "a@x.com", displayName: "A", organizer: true },
        { email: "room@x.com", resource: true },
      ],
    });
    expect(e.meeting?.platform).toBe("google_meet");
    expect(e.start?.toISOString()).toBe("2026-10-12T03:00:00.000Z");
    expect(e.attendees).toHaveLength(1);
    expect(normalizeGoogleEvent({ id: "x", status: "cancelled" }).cancelled).toBe(true);
    expect(normalizeGoogleEvent({ id: "y", start: { date: "2026-10-12" } }).isAllDay).toBe(true);
  });

  it("follows pagination and returns the sync token; uses syncToken incrementally", async () => {
    const urls: string[] = [];
    const responses = [
      json({ items: [{ id: "1" }], nextPageToken: "p2" }),
      json({ items: [{ id: "2" }], nextSyncToken: "sync-1" }),
    ];
    const api = new GoogleCalendarApi((async (u: string) => {
      urls.push(u);
      return responses.shift()!;
    }) as typeof fetch);
    const r = await api.listChanges({ accessToken: "t", cursor: null, ...win });
    expect(r.events.map((e) => e.providerEventId)).toEqual(["1", "2"]);
    expect(r.nextCursor).toBe("sync-1");
    expect(urls[0]).toContain("timeMin=");
    expect(urls[1]).toContain("pageToken=p2");

    const inc = new GoogleCalendarApi((async (u: string) => {
      urls.push(u);
      return json({ items: [], nextSyncToken: "sync-2" });
    }) as typeof fetch);
    await inc.listChanges({ accessToken: "t", cursor: "sync-1", ...win });
    expect(urls.at(-1)).toContain("syncToken=sync-1");
    expect(urls.at(-1)).not.toContain("timeMin");
  });

  it("maps 410 to cursor expiry, 401 to reauth, and rate limits to retryable errors", async () => {
    const api = (status: number, body: unknown = {}) =>
      new GoogleCalendarApi((async () => json(body, status)) as typeof fetch);
    await expect(
      api(410).listChanges({ accessToken: "t", cursor: "x", ...win }),
    ).rejects.toBeInstanceOf(CursorExpiredError);
    await expect(
      api(401).listChanges({ accessToken: "t", cursor: null, ...win }),
    ).rejects.toBeInstanceOf(ReauthRequiredError);
    await expect(
      api(403, { error: { errors: [{ reason: "rateLimitExceeded" }] } }).listChanges({
        accessToken: "t",
        cursor: null,
        ...win,
      }),
    ).rejects.toMatchObject({ retryable: true });
  });
});

describe("Microsoft Graph adapter", () => {
  it("normalizes Teams events (UTC dateTimes without offset) and removals", () => {
    const e = normalizeGraphEvent({
      id: "m1",
      changeKey: "ck",
      subject: "Sync",
      start: { dateTime: "2026-10-12T09:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-10-12T09:30:00.0000000", timeZone: "UTC" },
      isOnlineMeeting: true,
      onlineMeeting: {
        joinUrl: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0",
      },
      organizer: { emailAddress: { name: "Org", address: "org@x.com" } },
      attendees: [{ type: "required", emailAddress: { name: "Org", address: "org@x.com" } }],
    } as never);
    expect(e.meeting?.platform).toBe("microsoft_teams");
    expect(e.start?.toISOString()).toBe("2026-10-12T09:00:00.000Z");
    expect(e.attendees).toHaveLength(1); // de-duplicated
    expect(
      normalizeGraphEvent({ id: "gone", "@removed": { reason: "deleted" } } as never).cancelled,
    ).toBe(true);
  });

  it("follows nextLink to the deltaLink and never sends the token to other hosts", async () => {
    const seen: string[] = [];
    const responses = [
      json({
        value: [{ id: "1" }],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$skiptoken=2",
      }),
      json({
        value: [{ id: "2" }],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=d",
      }),
    ];
    const api = new MicrosoftCalendarApi((async (u: string) => {
      seen.push(u);
      return responses.shift()!;
    }) as typeof fetch);
    const r = await api.listChanges({ accessToken: "t", cursor: null, ...win });
    expect(r.nextCursor).toContain("deltatoken=d");
    expect(seen).toHaveLength(2);

    const evil = new MicrosoftCalendarApi((async () =>
      json({ value: [], "@odata.nextLink": "https://evil.example/steal" })) as typeof fetch);
    await expect(evil.listChanges({ accessToken: "t", cursor: null, ...win })).rejects.toThrow(
      /Unexpected Graph link host/,
    );
  });

  it("maps 410/SyncStateNotFound to cursor expiry", async () => {
    const api = new MicrosoftCalendarApi((async () =>
      json({ error: { code: "SyncStateNotFound" } }, 400)) as typeof fetch);
    await expect(
      api.listChanges({ accessToken: "t", cursor: "https://graph.microsoft.com/v1.0/x", ...win }),
    ).rejects.toBeInstanceOf(CursorExpiredError);
  });
});
