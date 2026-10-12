import { renderMinutesText, MinutesContentSchema, NOT_SPECIFIED } from "@notetaker/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { jobs, meetings } from "../src/db/schema";
import { ProviderError } from "../src/lib/errors";
import type { LlmProvider } from "../src/ai/types";
import { createTestContext, login, registerAdhoc, resetDb, sendWebhook, type LoggedIn, type TestContext } from "./helpers";

const ctx = createTestContext();
afterAll(() => ctx.close());
beforeEach(() => resetDb());

async function sessionId(c: TestContext, meetingId: string): Promise<string> {
  const [m] = await c.c.db.asSystem((tx) => tx.select().from(meetings).where(eq(meetings.id, meetingId)));
  expect(m?.providerSessionId).toBeTruthy();
  return m!.providerSessionId!;
}

async function status(u: LoggedIn, id: string) {
  return (await u.agent.get(`/api/v1/meetings/${id}`).expect(200)).body;
}

/** Registers a meeting starting now and drives the mock provider up to a stored recording. */
async function recordMeeting(c: TestContext, u: LoggedIn, title = "Launch planning") {
  const reg = await registerAdhoc(u, title, 0);
  expect(reg.status).toBe(200);
  expect(reg.body.status).toBe("queued");
  const id = reg.body.id as string;
  await c.c.runner.drain(); // bot_schedule -> provider session created
  const sid = await sessionId(c, id);
  for (const type of ["bot.joining", "bot.waiting_for_admission", "bot.in_call_recording", "bot.call_ended"]) {
    const r = await sendWebhook(c, { type, session_id: sid });
    expect(r.status).toBe(200);
  }
  return { id, sid };
}

describe("recording → transcript → summary → minutes pipeline (mock providers)", () => {
  it("runs the full lifecycle and only reports progress confirmed by the provider", async () => {
    const u = await login(ctx.app, "owner@example.com");
    const reg = await registerAdhoc(u, "Launch planning", 0);
    const id = reg.body.id as string;
    expect((await status(u, id)).status).toBe("queued");

    await ctx.c.runner.drain();
    // Session created, but nothing confirmed yet: still queued (not "in progress").
    expect((await status(u, id)).status).toBe("queued");
    const sid = await sessionId(ctx, id);

    await sendWebhook(ctx, { type: "bot.joining", session_id: sid }).expect(200);
    await sendWebhook(ctx, { type: "bot.waiting_for_admission", session_id: sid }).expect(200);
    let d = await status(u, id);
    expect(d.status).toBe("joining");
    expect(d.substatus).toBe("waiting_for_admission");

    await sendWebhook(ctx, { type: "bot.in_call_recording", session_id: sid }).expect(200);
    await sendWebhook(ctx, { type: "bot.participant_joined", session_id: sid, participant: { id: "p1", name: "Priya" } }).expect(200);
    expect((await status(u, id)).status).toBe("in_progress");

    await sendWebhook(ctx, { type: "bot.call_ended", session_id: sid }).expect(200);
    expect((await status(u, id)).status).toBe("recording_processing");
    await sendWebhook(ctx, { type: "bot.recording_ready", session_id: sid }).expect(200);

    await ctx.c.runner.drain(); // ingest -> transcribe -> summary
    d = await status(u, id);
    expect(d.status).toBe("completed");
    expect(d.recording).toBe("ready");
    expect(d.transcript).toBe("ready");
    expect(d.summary).toBe("ready");
    expect(d.minutes).toBe("none"); // minutes are generated on demand by default
    expect(d.participants).toEqual([{ displayName: "Priya", source: "provider" }]);
    expect(d.statusHistory.map((h: { to: string }) => h.to)).toEqual([
      "scheduled",
      "queued",
      "joining",
      "in_progress",
      "recording_processing",
      "completed",
    ]);

    // Recording metadata + authorized playback with HTTP Range
    const rec = (await u.agent.get(`/api/v1/meetings/${id}/recording`).expect(200)).body;
    expect(rec.status).toBe("ready");
    expect(rec.mimeType).toBe("audio/mp4");
    expect(rec.durationSeconds).toBeGreaterThan(5);
    const full = await u.agent.get(rec.streamUrl).buffer(true).expect(200);
    expect(full.headers["content-type"]).toBe("audio/mp4");
    expect(full.headers["cache-control"]).toBe("private, no-store");
    const partial = await u.agent.get(rec.streamUrl).set("Range", "bytes=0-99").buffer(true).expect(206);
    expect(partial.headers["content-range"]).toMatch(/^bytes 0-99\/\d+$/);
    expect(partial.headers["content-length"]).toBe("100");
    await u.agent.get(rec.streamUrl).set("Range", "bytes=999999999-").expect(416);
    const dl = await u.agent.get(rec.downloadUrl).buffer(true).expect(200);
    expect(dl.headers["content-disposition"]).toMatch(/^attachment; filename="meeting-\d{4}-\d{2}-\d{2}-launch-planning\.m4a"$/);

    // Transcript (mock fixture) with unverified speaker labels
    const tr = (await u.agent.get(`/api/v1/meetings/${id}/transcript`).expect(200)).body;
    expect(tr.status).toBe("completed");
    expect(tr.segments.length).toBeGreaterThan(3);
    expect(tr.speakerLabelsVerified).toBe(false);
    expect(tr.isMock).toBe(true);

    // Summary for THIS meeting
    const sum = (await u.agent.get(`/api/v1/meetings/${id}/summary`).expect(200)).body;
    expect(sum.status).toBe("completed");
    expect(sum.version).toBe(1);
    expect(sum.isMock).toBe(true);
    expect(sum.promptVersion).toBe("summary-v1");
    expect(sum.content.decisions.join(" ")).toMatch(/feature flag/);

    // Minutes: generate on demand, idempotent while in flight
    const g1 = await u.agent.post(`/api/v1/meetings/${id}/minutes/generate`).set("x-csrf-token", u.csrf).send({}).expect(202);
    const g2 = await u.agent.post(`/api/v1/meetings/${id}/minutes/generate`).set("x-csrf-token", u.csrf).send({}).expect(202);
    expect(g1.body.created).toBe(true);
    expect(g2.body.created).toBe(false);
    const minuteJobs = await ctx.c.db.asSystem((tx) => tx.select().from(jobs).where(eq(jobs.type, "generate_minutes")));
    expect(minuteJobs).toHaveLength(1);
    await ctx.c.runner.drain();

    const min = (await u.agent.get(`/api/v1/meetings/${id}/minutes`).expect(200)).body;
    expect(min.status).toBe("completed");
    const content = MinutesContentSchema.parse(min.content);
    expect(content.meetingDetails.title).toBe("Launch planning");
    expect(content.meetingDetails.participants).toEqual(["Priya"]);
    // Named owners kept, unknown owners never invented
    const priya = content.actionItems.find((a) => a.owner === "Priya");
    expect(priya?.dueDate).toBe("Friday");
    const unowned = content.actionItems.find((a) => /legal/i.test(a.task));
    expect(unowned?.owner).toBeNull();
    expect(unowned?.dueDate).toBeNull();
    // Proposals separated from decisions
    expect(content.proposals.map((p) => p.proposal).join(" ")).toMatch(/propose/);
    expect(content.decisions.map((p) => p.decision).join(" ")).not.toMatch(/propose/);
    // The copy text is exactly the shared renderer output for this meeting
    expect(min.renderedText).toBe(renderMinutesText(content));
    expect(min.renderedText).toContain(`Owner: ${NOT_SPECIFIED}`);

    // Explicit regeneration creates a new version; the previous one is shown meanwhile
    await u.agent.post(`/api/v1/meetings/${id}/minutes/generate`).set("x-csrf-token", u.csrf).send({ regenerate: true }).expect(202);
    const during = (await u.agent.get(`/api/v1/meetings/${id}/minutes`).expect(200)).body;
    expect(during.status).toBe("pending");
    expect(during.version).toBe(1);
    expect(during.content).not.toBeNull();
    await ctx.c.runner.drain();
    expect((await u.agent.get(`/api/v1/meetings/${id}/minutes`).expect(200)).body.version).toBe(2);
  });

  it("absorbs duplicate webhook deliveries and ignores out-of-order events", async () => {
    const u = await login(ctx.app, "dup@example.com");
    const reg = await registerAdhoc(u, "Dup test", 0);
    await ctx.c.runner.drain();
    const sid = await sessionId(ctx, reg.body.id);

    const first = await sendWebhook(ctx, { type: "bot.in_call_recording", session_id: sid }, { eventId: "evt_same" }).expect(200);
    expect(first.body.outcomes).toEqual(["applied"]);
    const replay = await sendWebhook(ctx, { type: "bot.in_call_recording", session_id: sid }, { eventId: "evt_same" }).expect(200);
    expect(replay.body.outcomes).toEqual(["duplicate"]);

    // A late "joining" after "in_progress" must not move the state backwards.
    const late = await sendWebhook(ctx, { type: "bot.joining", session_id: sid }).expect(200);
    expect(late.body.outcomes).toEqual(["ignored_invalid_transition"]);
    expect((await status(u, reg.body.id)).status).toBe("in_progress");

    // Duplicate completion events create a single ingest job / recording / transcript.
    await sendWebhook(ctx, { type: "bot.call_ended", session_id: sid }).expect(200);
    await sendWebhook(ctx, { type: "bot.recording_ready", session_id: sid }).expect(200);
    await sendWebhook(ctx, { type: "bot.recording_ready", session_id: sid }).expect(200);
    const ingestJobs = await ctx.c.db.asSystem((tx) => tx.select().from(jobs).where(eq(jobs.type, "recording_ingest")));
    expect(ingestJobs).toHaveLength(1);
    await ctx.c.runner.drain();
    const transcribeJobs = await ctx.c.db.asSystem((tx) => tx.select().from(jobs).where(eq(jobs.type, "transcribe")));
    expect(transcribeJobs).toHaveLength(1);
    const summaryJobs = await ctx.c.db.asSystem((tx) => tx.select().from(jobs).where(eq(jobs.type, "generate_summary")));
    expect(summaryJobs).toHaveLength(1);
    expect((await status(u, reg.body.id)).status).toBe("completed");
  });

  it("reports an admission failure clearly and never fakes a recording", async () => {
    const u = await login(ctx.app, "fail@example.com");
    const reg = await registerAdhoc(u, "Locked lobby", 0);
    await ctx.c.runner.drain();
    const sid = await sessionId(ctx, reg.body.id);
    await sendWebhook(ctx, { type: "bot.joining", session_id: sid }).expect(200);
    await sendWebhook(ctx, { type: "bot.failed", session_id: sid, error_code: "bot_admission_timeout" }).expect(200);
    const d = await status(u, reg.body.id);
    expect(d.status).toBe("failed");
    expect(d.failureCode).toBe("bot_admission_timeout");
    expect(d.failureMessage).toMatch(/not admitted/);
    expect(d.recording).toBe("none");
    const sum = (await u.agent.get(`/api/v1/meetings/${reg.body.id}/summary`).expect(200)).body;
    expect(sum.status).toBeNull();
    expect(sum.content).toBeNull();
    expect(sum.canGenerate).toBe(false);
    await u.agent.post(`/api/v1/meetings/${reg.body.id}/summary/generate`).set("x-csrf-token", u.csrf).send({}).expect(409);
  });

  it("normalizes unknown provider error codes", async () => {
    const u = await login(ctx.app, "codes@example.com");
    const reg = await registerAdhoc(u, "Weird failure", 0);
    await ctx.c.runner.drain();
    const sid = await sessionId(ctx, reg.body.id);
    await sendWebhook(ctx, { type: "bot.failed", session_id: sid, error_code: "internal_k8s_oom_secret_detail" }).expect(200);
    expect((await status(u, reg.body.id)).failureCode).toBe("provider_error");
  });

  it("marks the meeting failed when the provider has no recording", async () => {
    const u = await login(ctx.app, "norec@example.com");
    const { id } = await recordMeeting(ctx, u, "No audio [mock:no-recording]");
    await ctx.c.runner.drain();
    const d = await status(u, id);
    expect(d.status).toBe("failed");
    expect(d.failureCode).toBe("recording_unavailable");
    expect(d.recording).toBe("failed");
  });

  it("handles an empty transcript without fabricating a summary", async () => {
    const u = await login(ctx.app, "empty@example.com");
    const { id } = await recordMeeting(ctx, u, "Silent [mock:empty-transcript]");
    await ctx.c.runner.drain();
    const d = await status(u, id);
    expect(d.status).toBe("completed"); // the recording itself is valid
    expect(d.transcript).toBe("failed");
    expect(d.summary).toBe("none");
    const tr = (await u.agent.get(`/api/v1/meetings/${id}/transcript`).expect(200)).body;
    expect(tr.errorCode).toBe("transcript_empty");
    const sum = (await u.agent.get(`/api/v1/meetings/${id}/summary`).expect(200)).body;
    expect(sum.errorCode).toBe("transcript_unavailable");
    expect(sum.content).toBeNull();
  });

  it("explains that a too-short transcript cannot support reliable notes", async () => {
    const u = await login(ctx.app, "short@example.com");
    const { id } = await recordMeeting(ctx, u, "Mic check [mock:short-transcript]");
    await ctx.c.runner.drain();
    const sum = (await u.agent.get(`/api/v1/meetings/${id}/summary`).expect(200)).body;
    expect(sum.status).toBe("completed");
    expect(sum.content.insufficientSource).toBe(true);
    expect(sum.content.keyPoints).toEqual([]);
    expect(sum.renderedText).toMatch(/could not be generated/);
  });
});

describe("AI failures do not mark a valid recording as failed", () => {
  const failing: LlmProvider = {
    name: "failing",
    model: "x",
    isMock: true,
    async generateStructured() {
      throw new ProviderError("generation_failed", "boom", false);
    },
  };
  const c2 = createTestContext({}, { llm: failing });
  afterAll(() => c2.close());

  it("shows a failed summary with retry available, meeting still completed", async () => {
    const u = await login(c2.app, "aifail@example.com");
    const { id } = await recordMeeting(c2, u, "AI outage");
    await c2.c.runner.drain();
    const d = await status(u, id);
    expect(d.status).toBe("completed");
    expect(d.recording).toBe("ready");
    expect(d.summary).toBe("failed");
    const sum = (await u.agent.get(`/api/v1/meetings/${id}/summary`).expect(200)).body;
    expect(sum.status).toBe("failed");
    expect(sum.errorCode).toBe("generation_failed");
    expect(sum.canGenerate).toBe(true);
    const jobRows = await c2.c.db.asSystem((tx) => tx.select().from(jobs).where(eq(jobs.type, "generate_summary")));
    expect(jobRows[0]?.status).toBe("failed");
    expect(jobRows[0]?.attempts).toBe(1); // permanent error: not retried indefinitely
  });
});
