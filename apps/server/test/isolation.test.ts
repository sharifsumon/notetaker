import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  calendarConnections,
  meetingArtifacts,
  meetings,
  meetingStatusEvents,
  recordings,
  transcripts,
} from "../src/db/schema";
import {
  createTestContext,
  login,
  registerAdhoc,
  resetDb,
  sendWebhook,
  type LoggedIn,
} from "./helpers";

/**
 * Acceptance criterion 15: user A cannot access any content belonging to user B through
 * the API, and the database itself (row-level security) refuses cross-user access.
 */
const ctx = createTestContext();
let alice: LoggedIn;
let bob: LoggedIn;
let aliceMeeting: string;
let bobMeeting: string;

beforeAll(async () => {
  await resetDb();
  alice = await login(ctx.app, "alice@example.com");
  bob = await login(ctx.app, "bob@example.com");
  aliceMeeting = (await registerAdhoc(alice, "Alice secret strategy", 0)).body.id;
  bobMeeting = (await registerAdhoc(bob, "Bob roadmap", 0, "https://meet.google.com/zzz-yyyy-xxx"))
    .body.id;
  await ctx.c.runner.drain();
  // Drive Alice's meeting to completed with transcript, summary and minutes.
  const [m] = await ctx.c.db.asSystem((tx) =>
    tx.select().from(meetings).where(eq(meetings.id, aliceMeeting)),
  );
  for (const type of ["bot.in_call_recording", "bot.call_ended"]) {
    await sendWebhook(ctx, { type, session_id: m!.providerSessionId! }).expect(200);
  }
  await ctx.c.runner.drain();
  await alice.agent
    .post(`/api/v1/meetings/${aliceMeeting}/minutes/generate`)
    .set("x-csrf-token", alice.csrf)
    .send({})
    .expect(202);
  await ctx.c.runner.drain();
});
afterAll(() => ctx.close());

describe("API isolation", () => {
  it("the owner can access their meeting artifacts (sanity check)", async () => {
    await alice.agent.get(`/api/v1/meetings/${aliceMeeting}`).expect(200);
    const rec = await alice.agent.get(`/api/v1/meetings/${aliceMeeting}/recording`).expect(200);
    expect(rec.body.status).toBe("ready");
    await alice.agent.get(`/api/v1/meetings/${aliceMeeting}/recording/stream`).expect(200);
  });

  const readPaths = [
    "",
    "/recording",
    "/recording/stream",
    "/recording/download",
    "/transcript",
    "/summary",
    "/minutes",
  ];
  it.each(readPaths)(
    "GET /meetings/:id%s returns 404 for another user's meeting",
    async (suffix) => {
      const res = await bob.agent.get(`/api/v1/meetings/${aliceMeeting}${suffix}`).expect(404);
      expect(res.body.error.code).toBe("not_found");
      // Same response as a meeting that does not exist at all (no existence leak).
      const missing = await bob.agent
        .get(`/api/v1/meetings/00000000-0000-4000-8000-000000000000${suffix}`)
        .expect(404);
      expect(missing.body.error.message).toBe(res.body.error.message);
    },
  );

  it.each([
    ["post", "/cancel", {}],
    ["post", "/summary/generate", { regenerate: true }],
    ["post", "/minutes/generate", { regenerate: true }],
    ["delete", "", undefined],
  ] as const)(
    "%s /meetings/:id%s is refused for another user's meeting",
    async (method, suffix, body) => {
      const req = bob.agent[method](`/api/v1/meetings/${aliceMeeting}${suffix}`).set(
        "x-csrf-token",
        bob.csrf,
      );
      await (body ? req.send(body) : req).expect(404);
    },
  );

  it("registering another user's meeting by id is refused", async () => {
    await bob.agent
      .post("/api/v1/meetings/register")
      .set("x-csrf-token", bob.csrf)
      .send({ meetingId: aliceMeeting })
      .expect(404);
  });

  it("lists, counts and search results never include another user's meetings", async () => {
    const list = await bob.agent.get("/api/v1/meetings?q=strategy").expect(200);
    expect(list.body.items).toEqual([]);
    expect(list.body.total).toBe(0);
    const all = await bob.agent.get("/api/v1/meetings").expect(200);
    expect(all.body.items.map((m: { id: string }) => m.id)).toEqual([bobMeeting]);
    expect(all.body.stats.total).toBe(1);
  });

  it("Alice's data is unchanged after Bob's attempts", async () => {
    const d = await alice.agent.get(`/api/v1/meetings/${aliceMeeting}`).expect(200);
    expect(d.body.status).toBe("completed");
    expect(d.body.minutes).toBe("ready");
  });

  it("client-supplied user ids are ignored", async () => {
    await bob.agent
      .post("/api/v1/meetings/register")
      .set("x-csrf-token", bob.csrf)
      .send({ meetingId: aliceMeeting, userId: alice.userId })
      .expect(400);
  });

  it("malformed ids return 404, not a validation leak", async () => {
    await bob.agent.get("/api/v1/meetings/not-a-uuid/summary").expect(404);
  });

  it("calendar connections of another user cannot be synced or deleted", async () => {
    const [conn] = await ctx.c.db.asSystem((tx) =>
      tx
        .insert(calendarConnections)
        .values({
          userId: alice.userId,
          provider: "google_calendar",
          accountSubject: "g-alice",
          status: "active",
        })
        .returning(),
    );
    await bob.agent
      .post(`/api/v1/calendar-connections/${conn!.id}/sync`)
      .set("x-csrf-token", bob.csrf)
      .expect(404);
    await bob.agent
      .delete(`/api/v1/calendar-connections/${conn!.id}`)
      .set("x-csrf-token", bob.csrf)
      .expect(404);
    const bobList = await bob.agent.get("/api/v1/calendar-connections").expect(200);
    expect(bobList.body.items).toEqual([]);
  });
});

describe("database row-level security", () => {
  it("a user context cannot read another user's rows even without a WHERE filter", async () => {
    await ctx.c.db.asUser(bob.userId, async (tx) => {
      for (const t of [meetings, recordings, transcripts, meetingArtifacts, meetingStatusEvents]) {
        const rows = await tx.select().from(t);
        expect(rows.every((r) => (r as { userId: string }).userId === bob.userId)).toBe(true);
      }
      const direct = await tx.select().from(meetings).where(eq(meetings.id, aliceMeeting));
      expect(direct).toEqual([]);
    });
  });

  it("a user context cannot update or delete another user's rows", async () => {
    await ctx.c.db.asUser(bob.userId, async (tx) => {
      const upd = await tx
        .update(meetings)
        .set({ title: "pwned" })
        .where(eq(meetings.id, aliceMeeting))
        .returning();
      expect(upd).toEqual([]);
      const del = await tx
        .delete(transcripts)
        .where(eq(transcripts.meetingId, aliceMeeting))
        .returning();
      expect(del).toEqual([]);
    });
    const [m] = await ctx.c.db.asSystem((tx) =>
      tx.select().from(meetings).where(eq(meetings.id, aliceMeeting)),
    );
    expect(m?.title).toBe("Alice secret strategy");
  });

  it("cannot insert rows owned by another user or attach children to their meetings", async () => {
    await expect(
      ctx.c.db.asUser(bob.userId, (tx) =>
        tx.insert(meetings).values({
          userId: alice.userId,
          title: "x",
          platform: "google_meet",
          scheduledStartAt: new Date(),
          timezoneAtCreation: "UTC",
        }),
      ),
    ).rejects.toThrow();
    await expect(
      ctx.c.db.asUser(bob.userId, (tx) =>
        tx.insert(meetingStatusEvents).values({
          userId: bob.userId,
          meetingId: aliceMeeting,
          newStatus: "failed",
          source: "x",
        }),
      ),
    ).rejects.toThrow();
  });

  it("a connection with no user context sees nothing", async () => {
    const r = await ctx.c.db.pool.query("select count(*)::int as n from meetings");
    expect(r.rows[0].n).toBe(0);
  });

  it("the application role is not a superuser and cannot bypass RLS", async () => {
    const r = await ctx.c.db.orm.execute(
      sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
    );
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});
