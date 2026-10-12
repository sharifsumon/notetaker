import { readdirSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditEvents, jobs, meetings, recordings, transcripts } from "../src/db/schema";
import {
  createTestContext,
  futureIso,
  login,
  registerAdhoc,
  resetDb,
  sendWebhook,
} from "./helpers";

const ctx = createTestContext();
afterAll(() => ctx.close());
beforeEach(() => resetDb());

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? listFiles(path.join(dir, e.name)) : [path.join(dir, e.name)],
    );
  } catch {
    return [];
  }
}

describe("registration (FR-03)", () => {
  it("requires the recording notice to be acknowledged first", async () => {
    const u = await login(ctx.app, "noack@example.com", { acknowledge: false });
    const r = await registerAdhoc(u, "Weekly", 30);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("recording_notice_required");
  });

  it("accepts only supported Meet/Teams links", async () => {
    const u = await login(ctx.app, "url@example.com");
    for (const bad of [
      "https://zoom.us/j/1234",
      "https://meet.google.com.evil.io/abc-defg-hij",
      "http://meet.google.com/abc-defg-hij",
    ]) {
      const r = await registerAdhoc(u, "Bad", 30, bad);
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe("unsupported_meeting_url");
    }
    const teams = await registerAdhoc(
      u,
      "Teams",
      30,
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0",
    );
    expect(teams.status).toBe(200);
    expect(teams.body.platform).toBe("microsoft_teams");
  });

  it("is idempotent: the same link + time does not create duplicates", async () => {
    const u = await login(ctx.app, "idem@example.com");
    const startAt = futureIso(45);
    const body = { title: "Standup", meetingUrl: "https://meet.google.com/abc-defg-hij", startAt };
    const a = await u.agent
      .post("/api/v1/meetings/register")
      .set("x-csrf-token", u.csrf)
      .send(body)
      .expect(200);
    const b = await u.agent
      .post("/api/v1/meetings/register")
      .set("x-csrf-token", u.csrf)
      .send(body)
      .expect(200);
    expect(b.body.id).toBe(a.body.id);
    const again = await u.agent
      .post("/api/v1/meetings/register")
      .set("x-csrf-token", u.csrf)
      .send({ meetingId: a.body.id })
      .expect(200);
    expect(again.body.status).toBe("queued");
    const scheduleJobs = await ctx.c.db.asSystem((tx) =>
      tx.select().from(jobs).where(eq(jobs.type, "bot_schedule")),
    );
    expect(scheduleJobs).toHaveLength(1);
  });

  it("schedules the bot shortly before the start time, not immediately", async () => {
    const u = await login(ctx.app, "sched@example.com");
    await registerAdhoc(u, "Later", 120);
    const [job] = await ctx.c.db.asSystem((tx) =>
      tx.select().from(jobs).where(eq(jobs.type, "bot_schedule")),
    );
    expect(job!.runAt.getTime()).toBeGreaterThan(Date.now() + 100 * 60_000);
    expect(await ctx.c.runner.drain()).toBe(0);
  });

  it("rejects meetings that already ended", async () => {
    const u = await login(ctx.app, "past@example.com");
    const r = await u.agent
      .post("/api/v1/meetings/register")
      .set("x-csrf-token", u.csrf)
      .send({
        title: "Old",
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        startAt: futureIso(-180),
        endAt: futureIso(-120),
      });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("meeting_ended");
  });

  it("records who registered and audits it", async () => {
    const u = await login(ctx.app, "audit@example.com");
    const r = await registerAdhoc(u, "Audited", 30);
    const [m] = await ctx.c.db.asSystem((tx) =>
      tx.select().from(meetings).where(eq(meetings.id, r.body.id)),
    );
    expect(m?.registrationSource).toBe("manual");
    expect(m?.registeredBy).toBe(u.userId);
    expect(m?.encryptedMeetingUrl).not.toContain("meet.google.com"); // encrypted at rest
    const audits = await ctx.c.db.asSystem((tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, "meeting.registered")),
    );
    expect(audits).toHaveLength(1);
  });
});

describe("cancellation", () => {
  it("cancels before the bot joins and cancels the provider session", async () => {
    const u = await login(ctx.app, "cancel@example.com");
    const r = await registerAdhoc(u, "Cancel me", 0);
    await ctx.c.runner.drain();
    const c = await u.agent
      .post(`/api/v1/meetings/${r.body.id}/cancel`)
      .set("x-csrf-token", u.csrf)
      .expect(200);
    expect(c.body.status).toBe("cancelled");
    const cancelJobs = await ctx.c.db.asSystem((tx) =>
      tx.select().from(jobs).where(eq(jobs.type, "bot_cancel")),
    );
    expect(cancelJobs).toHaveLength(1);
    await ctx.c.runner.drain();
    // Re-registering a cancelled future meeting is allowed.
    const again = await u.agent
      .post("/api/v1/meetings/register")
      .set("x-csrf-token", u.csrf)
      .send({ meetingId: r.body.id })
      .expect(200);
    expect(again.body.status).toBe("queued");
  });

  it("cannot cancel once recording is in progress", async () => {
    const u = await login(ctx.app, "late@example.com");
    const r = await registerAdhoc(u, "Live", 0);
    await ctx.c.runner.drain();
    const [m] = await ctx.c.db.asSystem((tx) =>
      tx.select().from(meetings).where(eq(meetings.id, r.body.id)),
    );
    await sendWebhook(ctx, {
      type: "bot.in_call_recording",
      session_id: m!.providerSessionId!,
    }).expect(200);
    const c = await u.agent
      .post(`/api/v1/meetings/${r.body.id}/cancel`)
      .set("x-csrf-token", u.csrf)
      .expect(409);
    expect(c.body.error.code).toBe("not_cancellable");
  });
});

describe("dashboard listing (FR-06)", () => {
  it("paginates, filters and searches", async () => {
    const u = await login(ctx.app, "list@example.com");
    for (let i = 0; i < 5; i++) {
      await registerAdhoc(
        u,
        `Sprint review ${i}`,
        30 + i * 60,
        `https://meet.google.com/abc-defg-hi${"abcde"[i]}`,
      );
    }
    await registerAdhoc(u, "Teams sync", 400, "https://teams.microsoft.com/meet/123456");
    const p1 = await u.agent.get("/api/v1/meetings?pageSize=4&page=1&view=upcoming").expect(200);
    expect(p1.body.items).toHaveLength(4);
    expect(p1.body.total).toBe(6);
    expect(p1.body.items[0].title).toBe("Sprint review 0"); // upcoming = soonest first
    const p2 = await u.agent.get("/api/v1/meetings?pageSize=4&page=2&view=upcoming").expect(200);
    expect(p2.body.items).toHaveLength(2);

    const teams = await u.agent.get("/api/v1/meetings?platform=microsoft_teams").expect(200);
    expect(teams.body.items.map((m: { title: string }) => m.title)).toEqual(["Teams sync"]);
    const search = await u.agent.get("/api/v1/meetings?q=review%203").expect(200);
    expect(search.body.items).toHaveLength(1);
    const pct = await u.agent.get("/api/v1/meetings?q=%25").expect(200); // literal %, not a wildcard
    expect(pct.body.items).toHaveLength(0);
    const byStatus = await u.agent.get("/api/v1/meetings?status=queued").expect(200);
    expect(byStatus.body.total).toBe(6);
    const range = await u.agent
      .get(`/api/v1/meetings?from=${encodeURIComponent(futureIso(200))}`)
      .expect(200);
    expect(range.body.total).toBe(3);
    expect(p1.body.items[0]).toMatchObject({
      recording: "none",
      summary: "none",
      minutes: "none",
      canCancel: true,
    });
  });

  it("validates query parameters and bounds page size", async () => {
    const u = await login(ctx.app, "bounds@example.com");
    await u.agent.get("/api/v1/meetings?pageSize=1000").expect(400);
    await u.agent.get("/api/v1/meetings?platform=zoom").expect(400);
    await u.agent.get("/api/v1/meetings?unknown=1").expect(400);
  });
});

describe("deletion (FR-14)", () => {
  it("is asynchronous, removes stored audio and derived content, and is audited without content", async () => {
    const u = await login(ctx.app, "del@example.com");
    const r = await registerAdhoc(u, "Delete me", 0);
    await ctx.c.runner.drain();
    const [m] = await ctx.c.db.asSystem((tx) =>
      tx.select().from(meetings).where(eq(meetings.id, r.body.id)),
    );
    for (const type of ["bot.in_call_recording", "bot.call_ended"]) {
      await sendWebhook(ctx, { type, session_id: m!.providerSessionId! }).expect(200);
    }
    await ctx.c.runner.drain();
    expect(listFiles(ctx.storageDir).filter((f) => f.endsWith(".m4a"))).toHaveLength(1);

    await u.agent.delete(`/api/v1/meetings/${r.body.id}`).set("x-csrf-token", u.csrf).expect(202);
    const pending = await u.agent.get(`/api/v1/meetings/${r.body.id}`).expect(200);
    expect(pending.body.status).toBe("deletion_pending");
    // Media is no longer served while deletion is pending.
    await u.agent.get(`/api/v1/meetings/${r.body.id}/recording/stream`).expect(409);

    await ctx.c.runner.drain();
    await u.agent.get(`/api/v1/meetings/${r.body.id}`).expect(404);
    expect(listFiles(ctx.storageDir).filter((f) => f.endsWith(".m4a"))).toHaveLength(0);
    const left = await ctx.c.db.asSystem(async (tx) => ({
      rec: await tx.select().from(recordings).where(eq(recordings.meetingId, r.body.id)),
      tr: await tx.select().from(transcripts).where(eq(transcripts.meetingId, r.body.id)),
      m: await tx.select().from(meetings).where(eq(meetings.id, r.body.id)),
    }));
    expect(left.rec).toHaveLength(0);
    expect(left.tr).toHaveLength(0);
    expect(left.m[0]?.title).toBe("[deleted]");
    expect(left.m[0]?.encryptedMeetingUrl).toBeNull();
    const [audit] = await ctx.c.db.asSystem((tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, "meeting.deleted")),
    );
    expect(audit?.metadata).toMatchObject({
      reason: "user_request",
      recordings: 1,
      transcripts: 1,
    });
    expect(JSON.stringify(audit?.metadata)).not.toMatch(/Delete me|feature flag/);
  });

  it("retention sweep queues deletion of recordings past the retention period", async () => {
    const u = await login(ctx.app, "ret@example.com");
    const r = await registerAdhoc(u, "Old recording", 0);
    await ctx.c.runner.drain();
    const [m] = await ctx.c.db.asSystem((tx) =>
      tx.select().from(meetings).where(eq(meetings.id, r.body.id)),
    );
    for (const type of ["bot.in_call_recording", "bot.call_ended"]) {
      await sendWebhook(ctx, { type, session_id: m!.providerSessionId! }).expect(200);
    }
    await ctx.c.runner.drain();
    expect(await ctx.c.deletion.enqueueRetention(new Date(Date.now() + 89 * 86_400_000))).toBe(0);
    expect(await ctx.c.deletion.enqueueRetention(new Date(Date.now() + 91 * 86_400_000))).toBe(1);
    await ctx.c.runner.drain();
    await u.agent.get(`/api/v1/meetings/${r.body.id}`).expect(404);
  });
});
