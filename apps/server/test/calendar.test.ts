import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ReauthRequiredError, type OAuthClient } from "../src/auth/oauth";
import { CursorExpiredError, type CalendarApi, type ChangesResult, type NormalizedEvent } from "../src/calendar/types";
import { calendarConnections, jobs, meetingParticipants, meetings, users } from "../src/db/schema";
import { detectMeetingUrl } from "@notetaker/shared";
import { createTestContext, login, resetDb } from "./helpers";

/** Scriptable calendar API double. */
class FakeCalendarApi implements CalendarApi {
  readonly provider = "google_calendar" as const;
  responses: Array<ChangesResult | Error> = [];
  calls: Array<{ cursor: string | null }> = [];
  async listChanges(opts: { cursor: string | null }): Promise<ChangesResult> {
    this.calls.push({ cursor: opts.cursor });
    const r = this.responses.shift() ?? { events: [], nextCursor: "c-empty" };
    if (r instanceof Error) throw r;
    return r;
  }
}

const fakeOAuth = {
  provider: "google",
  refresh: async () => {
    throw new ReauthRequiredError();
  },
  revoke: async () => undefined,
} as unknown as OAuthClient;

const api = new FakeCalendarApi();
const ctx = createTestContext({}, { calendarApis: { google_calendar: api }, oauth: { google: fakeOAuth } });
afterAll(() => ctx.close());

const hours = (h: number) => new Date(Date.now() + h * 3600_000);
function ev(id: string, over: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    providerEventId: id,
    version: "v1",
    cancelled: false,
    title: `Event ${id}`,
    start: hours(24),
    end: hours(25),
    isAllDay: false,
    meeting: detectMeetingUrl("https://meet.google.com/abc-defg-hij"),
    attendees: [{ key: "priya@example.com", name: "Priya", email: "priya@example.com", type: "organizer" }],
    ...over,
  };
}

async function setup(autoRegister = false) {
  await resetDb();
  api.responses = [];
  api.calls = [];
  const u = await login(ctx.app, "cal@example.com");
  if (autoRegister) {
    await u.agent.patch("/api/v1/me/settings").set("x-csrf-token", u.csrf).send({ autoRegister: true }).expect(200);
  }
  // Store a connection with a valid (not expiring) access token so no refresh is needed.
  const [conn] = await ctx.c.db.asSystem((tx) =>
    tx
      .insert(calendarConnections)
      .values({
        userId: u.userId,
        provider: "google_calendar",
        accountSubject: "g-123",
        accountEmail: "cal@example.com",
        encryptedRefreshToken: ctx.c.cipher.encrypt("refresh", `calendar:${u.userId}:google_calendar`),
        encryptedAccessToken: ctx.c.cipher.encrypt("access", `calendar:${u.userId}:google_calendar`),
        accessTokenExpiresAt: hours(1),
        status: "active",
      })
      .returning(),
  );
  return { u, connId: conn!.id };
}

const userMeetings = (userId: string) =>
  ctx.c.db.asSystem((tx) => tx.select().from(meetings).where(eq(meetings.userId, userId)));

describe("calendar sync (FR-02)", () => {
  beforeEach(() => resetDb());

  it("creates meetings only for supported links and never duplicates on repeated sync", async () => {
    const { u, connId } = await setup();
    const events = [
      ev("e1"),
      ev("e2", { meeting: detectMeetingUrl("https://teams.microsoft.com/meet/987654") }),
      ev("zoom", { meeting: null }), // unsupported link → not a meeting
      ev("allday", { isAllDay: true }),
    ];
    api.responses = [{ events, nextCursor: "c1" }, { events, nextCursor: "c2" }];
    await ctx.c.calendar.sync(connId);
    await ctx.c.calendar.sync(connId);
    const rows = await userMeetings(u.userId);
    expect(rows.map((m) => m.providerEventId).sort()).toEqual(["e1", "e2"]);
    expect(api.calls.map((c) => c.cursor)).toEqual([null, "c1"]); // incremental after first sync
    const parts = await ctx.c.db.asSystem((tx) => tx.select().from(meetingParticipants));
    expect(parts.filter((p) => p.source === "calendar")).toHaveLength(2);
    expect(parts.every((p) => p.email === null)).toBe(true); // data minimization
    const list = await u.agent.get("/api/v1/meetings").expect(200);
    expect(list.body.total).toBe(2);
    expect(list.body.items[0].canRegister).toBe(true);
    const [conn] = await ctx.c.db.asSystem((tx) => tx.select().from(calendarConnections).where(eq(calendarConnections.id, connId)));
    expect(conn?.lastSyncedAt).not.toBeNull();
    expect(conn?.syncState?.cursor).toBe("c2");
  });

  it("handles reschedules of registered meetings by rescheduling the bot", async () => {
    const { u, connId } = await setup();
    api.responses = [{ events: [ev("e1")], nextCursor: "c1" }];
    await ctx.c.calendar.sync(connId);
    const [m] = await userMeetings(u.userId);
    await u.agent.post("/api/v1/meetings/register").set("x-csrf-token", u.csrf).send({ meetingId: m!.id }).expect(200);

    api.responses = [{ events: [ev("e1", { version: "v2", start: hours(48), end: hours(49), title: "Moved" })], nextCursor: "c2" }];
    await ctx.c.calendar.sync(connId);
    const [moved] = await userMeetings(u.userId);
    expect(moved?.title).toBe("Moved");
    expect(moved?.status).toBe("queued");
    expect(moved!.scheduledStartAt.getTime()).toBeGreaterThan(Date.now() + 47 * 3600_000);
    const sched = await ctx.c.db.asSystem((tx) => tx.select().from(jobs).where(eq(jobs.type, "bot_schedule")));
    const pending = sched.filter((j) => j.status === "pending");
    const cancelled = sched.filter((j) => j.status === "cancelled");
    expect(pending).toHaveLength(1);
    expect(cancelled).toHaveLength(1);
    expect(pending[0]!.runAt.getTime()).toBeGreaterThan(Date.now() + 47 * 3600_000);
  });

  it("cancels meetings whose calendar event was cancelled or deleted", async () => {
    const { u, connId } = await setup();
    api.responses = [{ events: [ev("e1"), ev("e2")], nextCursor: "c1" }];
    await ctx.c.calendar.sync(connId);
    const rows = await userMeetings(u.userId);
    const e2 = rows.find((r) => r.providerEventId === "e2")!;
    await u.agent.post("/api/v1/meetings/register").set("x-csrf-token", u.csrf).send({ meetingId: e2.id }).expect(200);

    api.responses = [{ events: [ev("e1", { cancelled: true }), ev("e2", { cancelled: true })], nextCursor: "c2" }];
    await ctx.c.calendar.sync(connId);
    const after = await userMeetings(u.userId);
    expect(after.every((m) => m.status === "cancelled")).toBe(true);
    const sched = await ctx.c.db.asSystem((tx) =>
      tx.select().from(jobs).where(and(eq(jobs.type, "bot_schedule"), eq(jobs.status, "pending"))),
    );
    expect(sched).toHaveLength(0);
  });

  it("does not resurrect meetings the user deleted", async () => {
    const { u, connId } = await setup();
    api.responses = [{ events: [ev("e1")], nextCursor: "c1" }];
    await ctx.c.calendar.sync(connId);
    const [m] = await userMeetings(u.userId);
    await u.agent.delete(`/api/v1/meetings/${m!.id}`).set("x-csrf-token", u.csrf).expect(202);
    await ctx.c.runner.drain();
    api.responses = [{ events: [ev("e1", { version: "v9" })], nextCursor: "c2" }];
    await ctx.c.calendar.sync(connId);
    const list = await u.agent.get("/api/v1/meetings").expect(200);
    expect(list.body.total).toBe(0);
  });

  it("recovers from an expired sync cursor with a full resync", async () => {
    const { connId } = await setup();
    api.responses = [{ events: [ev("e1")], nextCursor: "c1" }];
    await ctx.c.calendar.sync(connId);
    api.responses = [new CursorExpiredError(), { events: [ev("e1")], nextCursor: "fresh" }];
    await ctx.c.calendar.sync(connId);
    expect(api.calls.map((c) => c.cursor)).toEqual([null, "c1", null]);
  });

  it("marks the connection reconnect_required when consent is revoked", async () => {
    const { u, connId } = await setup();
    // Expire the access token so a refresh is attempted (fake refresh → invalid_grant).
    await ctx.c.db.asSystem((tx) =>
      tx.update(calendarConnections).set({ accessTokenExpiresAt: hours(-1) }).where(eq(calendarConnections.id, connId)),
    );
    await ctx.c.calendar.sync(connId);
    const list = await u.agent.get("/api/v1/calendar-connections").expect(200);
    expect(list.body.items[0]).toMatchObject({ status: "reconnect_required", lastErrorCode: "calendar_reconnect_required" });
    const r = await u.agent.post(`/api/v1/calendar-connections/${connId}/sync`).set("x-csrf-token", u.csrf).expect(409);
    expect(r.body.error.code).toBe("calendar_reconnect_required");
  });

  it("auto-registers only future meetings and only with an explicit opt-in", async () => {
    const off = await setup(false);
    api.responses = [{ events: [ev("e1")], nextCursor: "c1" }];
    await ctx.c.calendar.sync(off.connId);
    expect((await userMeetings(off.u.userId))[0]?.status).toBe("scheduled");

    const on = await setup(true);
    api.responses = [{ events: [ev("future"), ev("past", { start: hours(-30), end: hours(-29) })], nextCursor: "c1" }];
    await ctx.c.calendar.sync(on.connId);
    const rows = await userMeetings(on.u.userId);
    expect(rows.find((r) => r.providerEventId === "future")).toMatchObject({ status: "queued", registrationSource: "auto" });
    expect(rows.find((r) => r.providerEventId === "past")?.status).toBe("scheduled");
  });

  it("disconnect deletes tokens and removes unregistered future synced meetings", async () => {
    const { u, connId } = await setup();
    api.responses = [{ events: [ev("e1"), ev("e2")], nextCursor: "c1" }];
    await ctx.c.calendar.sync(connId);
    const rows = await userMeetings(u.userId);
    await u.agent.post("/api/v1/meetings/register").set("x-csrf-token", u.csrf).send({ meetingId: rows[0]!.id }).expect(200);
    await u.agent.delete(`/api/v1/calendar-connections/${connId}`).set("x-csrf-token", u.csrf).expect(204);
    const [conn] = await ctx.c.db.asSystem((tx) => tx.select().from(calendarConnections).where(eq(calendarConnections.id, connId)));
    expect(conn).toMatchObject({ status: "disconnected", encryptedRefreshToken: null, encryptedAccessToken: null });
    const list = await u.agent.get("/api/v1/meetings").expect(200);
    expect(list.body.total).toBe(1); // the registered one is kept
    expect((await u.agent.get("/api/v1/calendar-connections").expect(200)).body.items).toEqual([]);
  });

  it("calendar connect requires configured providers", async () => {
    const { u } = await setup();
    const r = await u.agent.post("/api/v1/calendar-connections/microsoft_calendar/connect").set("x-csrf-token", u.csrf).expect(503);
    expect(r.body.error.code).toBe("not_configured");
    const [user] = await ctx.c.db.asSystem((tx) => tx.select().from(users).where(eq(users.id, u.userId)));
    expect(user).toBeTruthy();
  });
});
