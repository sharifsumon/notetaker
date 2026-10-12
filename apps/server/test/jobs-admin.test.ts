import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditEvents, jobs, users } from "../src/db/schema";
import { backoffMs } from "../src/jobs/job.service";
import { JobRunner } from "../src/jobs/runner";
import { ProviderError } from "../src/lib/errors";
import { createTestContext, login, resetDb } from "./helpers";

const ctx = createTestContext();
afterAll(() => ctx.close());
beforeEach(() => resetDb());

describe("durable jobs", () => {
  it("enqueue is idempotent by key", async () => {
    await ctx.c.db.asSystem(async (tx) => {
      const a = await ctx.c.jobs.enqueue(tx, { type: "calendar_sync", idempotencyKey: "k1", entityId: "x" });
      const b = await ctx.c.jobs.enqueue(tx, { type: "calendar_sync", idempotencyKey: "k1", entityId: "x" });
      expect(a.created).toBe(true);
      expect(b.created).toBe(false);
      expect(b.job.id).toBe(a.job.id);
    });
  });

  it("retries transient failures with bounded backoff and dead-letters after max attempts", async () => {
    let calls = 0;
    let finalFailures = 0;
    const runner = new JobRunner(
      ctx.c.db,
      ctx.c.jobs,
      {
        calendar_sync: {
          run: async () => {
            calls++;
            throw new ProviderError("calendar_rate_limited", "429", true);
          },
          onFinalFailure: async () => void finalFailures++,
        },
      },
      ctx.c.logger,
      ctx.c.metrics,
    );
    const job = await ctx.c.db.asSystem((tx) =>
      ctx.c.jobs.enqueue(tx, { type: "calendar_sync", idempotencyKey: "retry-me", maxAttempts: 3 }),
    );
    for (let i = 0; i < 3; i++) {
      // Make it due immediately, then run.
      await ctx.c.db.asSystem((tx) => tx.update(jobs).set({ runAt: new Date(0) }).where(eq(jobs.id, job.job.id)));
      await runner.drain(1);
    }
    const [row] = await ctx.c.db.asSystem((tx) => tx.select().from(jobs).where(eq(jobs.id, job.job.id)));
    expect(calls).toBe(3);
    expect(row).toMatchObject({ status: "failed", attempts: 3, lastErrorCode: "calendar_rate_limited" });
    expect(finalFailures).toBe(1);
  });

  it("backoff grows exponentially and is capped", () => {
    expect(backoffMs(1)).toBeLessThanOrEqual(5_000);
    expect(backoffMs(3)).toBeGreaterThanOrEqual(10_000);
    expect(backoffMs(30)).toBeLessThanOrEqual(15 * 60_000);
  });

  it("re-queues jobs abandoned by a crashed worker", async () => {
    const { job } = await ctx.c.db.asSystem((tx) => ctx.c.jobs.enqueue(tx, { type: "calendar_sync", idempotencyKey: "stale" }));
    await ctx.c.db.asSystem((tx) =>
      tx.update(jobs).set({ status: "running", updatedAt: new Date(Date.now() - 3 * 3600_000) }).where(eq(jobs.id, job.id)),
    );
    expect(await ctx.c.db.asSystem((tx) => ctx.c.jobs.reapStale(tx, 90 * 60_000))).toBe(1);
  });
});

describe("admin operations (FR-15)", () => {
  async function admin() {
    const u = await login(ctx.app, "ops@example.com");
    await ctx.c.db.asSystem((tx) => tx.update(users).set({ role: "admin" }).where(eq(users.id, u.userId)));
    return u;
  }

  it("is forbidden to regular users", async () => {
    const u = await login(ctx.app, "user@example.com");
    await u.agent.get("/api/v1/admin/overview").expect(403);
    await u.agent.get("/api/v1/admin/jobs").expect(403);
  });

  it("shows provider health and job counts without user content", async () => {
    const a = await admin();
    const r = await a.agent.get("/api/v1/admin/overview").expect(200);
    expect(r.body.providers.meetingBot).toMatchObject({ name: "mock", mock: true, ok: true });
    expect(r.body.providers.database).toEqual({ ok: true });
    expect(JSON.stringify(r.body)).not.toMatch(/transcript|summary"|minutes"/i);
  });

  it("retries a failed job and audits the action", async () => {
    const a = await admin();
    const { job } = await ctx.c.db.asSystem((tx) => ctx.c.jobs.enqueue(tx, { type: "calendar_sync", idempotencyKey: "dead" }));
    await ctx.c.db.asSystem((tx) => tx.update(jobs).set({ status: "failed", attempts: 5 }).where(eq(jobs.id, job.id)));
    const list = await a.agent.get("/api/v1/admin/jobs?status=failed").expect(200);
    expect(list.body.items.map((j: { id: string }) => j.id)).toContain(job.id);
    await a.agent.post(`/api/v1/admin/jobs/${job.id}/retry`).set("x-csrf-token", a.csrf).expect(202);
    const [row] = await ctx.c.db.asSystem((tx) => tx.select().from(jobs).where(eq(jobs.id, job.id)));
    expect(row?.status).toBe("pending");
    expect(row!.maxAttempts).toBeGreaterThan(5);
    await a.agent.post(`/api/v1/admin/jobs/${job.id}/retry`).set("x-csrf-token", a.csrf).expect(409);
    const audit = await ctx.c.db.asSystem((tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, "admin.job_retried")));
    expect(audit).toHaveLength(1);
  });

  it("audit events cannot be modified by the application role", async () => {
    await login(ctx.app, "x@example.com");
    await expect(ctx.c.db.asSystem((tx) => tx.update(auditEvents).set({ action: "tampered" }))).rejects.toMatchObject({ cause: { code: "42501" } });
    await expect(ctx.c.db.asSystem((tx) => tx.delete(auditEvents))).rejects.toMatchObject({ cause: { code: "42501" } });
  });
});

describe("health & docs", () => {
  it("exposes liveness, readiness and the OpenAPI document", async () => {
    const st = (await import("supertest")).default;
    await st(ctx.app).get("/api/v1/health/live").expect(200);
    const ready = await st(ctx.app).get("/api/v1/health/ready").expect(200);
    expect(ready.body.checks).toMatchObject({ database: true, storage: true });
    const doc = await st(ctx.app).get("/api/v1/openapi.json").expect(200);
    expect(doc.body.openapi).toBe("3.1.0");
    expect(Object.keys(doc.body.paths)).toEqual(
      expect.arrayContaining(["/api/v1/meetings", "/api/v1/meetings/{meetingId}/minutes/generate", "/api/v1/webhooks/meeting-provider/{provider}"]),
    );
    const metrics = await st(ctx.app).get("/metrics").expect(200);
    expect(metrics.text).toMatch(/jobs_processed_total|http_request_duration_seconds/);
  });

  it("returns a consistent error envelope for unknown routes", async () => {
    const st = (await import("supertest")).default;
    const r = await st(ctx.app).get("/api/v1/nope").expect(404);
    expect(r.body.error).toMatchObject({ code: "not_found" });
    expect(r.headers["x-request-id"]).toBeTruthy();
  });
});
