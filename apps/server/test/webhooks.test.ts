import { eq } from "drizzle-orm";
import supertest from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { meetings, webhookEvents } from "../src/db/schema";
import { createTestContext, login, registerAdhoc, resetDb, sendWebhook } from "./helpers";

const ctx = createTestContext();
afterAll(() => ctx.close());
beforeEach(() => resetDb());

async function queuedSession() {
  const u = await login(ctx.app, "wh@example.com");
  const reg = await registerAdhoc(u, "Webhook test", 0);
  await ctx.c.runner.drain();
  const [m] = await ctx.c.db.asSystem((tx) =>
    tx.select().from(meetings).where(eq(meetings.id, reg.body.id)),
  );
  return { u, id: reg.body.id as string, sid: m!.providerSessionId! };
}

describe("webhook verification (FR-04)", () => {
  it("rejects a bad signature and leaves state unchanged", async () => {
    const { sid, id } = await queuedSession();
    const r = await sendWebhook(
      ctx,
      { type: "bot.in_call_recording", session_id: sid },
      { secretOverride: "wrong-secret" },
    ).expect(401);
    expect(r.body.error.code).toBe("webhook_verification_failed");
    const [m] = await ctx.c.db.asSystem((tx) =>
      tx.select().from(meetings).where(eq(meetings.id, id)),
    );
    expect(m?.status).toBe("queued");
    const inbox = await ctx.c.db.asSystem((tx) => tx.select().from(webhookEvents));
    expect(inbox).toHaveLength(0);
  });

  it("rejects stale (replayed) deliveries outside the tolerance window", async () => {
    const { sid } = await queuedSession();
    const old = Math.floor(Date.now() / 1000) - 3600;
    await sendWebhook(ctx, { type: "bot.joining", session_id: sid }, { timestamp: old }).expect(
      401,
    );
  });

  it("rejects missing signature headers and malformed bodies", async () => {
    await supertest(ctx.app)
      .post("/api/v1/webhooks/meeting-provider/mock")
      .set("content-type", "application/json")
      .send(JSON.stringify({ type: "bot.joining" }))
      .expect(401);
    const { sid } = await queuedSession();
    await sendWebhook(ctx, { type: "bot.do_evil", session_id: sid }).expect(401);
  });

  it("returns 404 for unknown providers", async () => {
    await supertest(ctx.app).post("/api/v1/webhooks/meeting-provider/other").send("{}").expect(404);
  });

  it("records unknown sessions without changing anything", async () => {
    const r = await sendWebhook(ctx, { type: "bot.joining", session_id: "mock_unknown.x" }).expect(
      200,
    );
    expect(r.body.outcomes).toEqual(["unknown_session"]);
  });

  it("does not require a CSRF token or session (signature-authenticated)", async () => {
    const { sid } = await queuedSession();
    const r = await sendWebhook(ctx, { type: "bot.joining", session_id: sid }).expect(200);
    expect(r.body.outcomes).toEqual(["applied"]);
  });

  it("replaying an identical signed delivery is a no-op", async () => {
    const { sid, id } = await queuedSession();
    await sendWebhook(
      ctx,
      { type: "bot.failed", session_id: sid, error_code: "bot_denied_admission" },
      { eventId: "evt_x" },
    ).expect(200);
    const again = await sendWebhook(
      ctx,
      { type: "bot.failed", session_id: sid, error_code: "bot_denied_admission" },
      { eventId: "evt_x" },
    ).expect(200);
    expect(again.body.outcomes).toEqual(["duplicate"]);
    const history = await ctx.c.meetings.detail(
      (await ctx.c.db.asSystem((tx) => tx.select().from(meetings).where(eq(meetings.id, id))))[0]!
        .userId,
      id,
    );
    expect(history.statusHistory.filter((h) => h.to === "failed")).toHaveLength(1);
  });
});

describe("reconciliation when webhooks are missed", () => {
  it("polls provider state and applies only what the provider reports", async () => {
    const { sid, id } = await queuedSession();
    // Simulate time passing: mark the meeting as stale so reconcile picks it up.
    await ctx.c.db.asSystem((tx) =>
      tx
        .update(meetings)
        .set({
          updatedAt: new Date(Date.now() - 3600_000),
          scheduledStartAt: new Date(Date.now() - 60_000),
        })
        .where(eq(meetings.id, id)),
    );
    // Mock provider with step 0 reports the session as done immediately.
    (ctx.c.bot as unknown as { opts: { stepMs: number } }).opts.stepMs = 0;
    const applied = await ctx.c.botService.reconcile();
    expect(applied).toBeGreaterThan(0);
    const [m] = await ctx.c.db.asSystem((tx) =>
      tx.select().from(meetings).where(eq(meetings.id, id)),
    );
    expect(m?.status).toBe("recording_processing");
    expect(sid).toBeTruthy();
  });
});
