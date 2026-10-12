import { AdminJobSchema, type AdminJob } from "@notetaker/shared";
import { and, count, desc, eq, sql, type SQL } from "drizzle-orm";
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import type { Container } from "../container";
import { calendarConnections, jobs, webhookEvents } from "../db/schema";
import { Errors } from "../lib/errors";
import { route, uuidParams } from "../lib/http";
import { JOB_TYPES } from "../jobs/job.service";
import { requireAdmin } from "./middleware";

/**
 * Operations endpoints (FR-15). Expose job/provider health and safe error codes only —
 * never recordings, transcripts, summaries or minutes.
 */
export function adminRoutes(
  c: Container,
  adminLimiter: RequestHandler,
  queueCounts?: () => Promise<unknown>,
): Router {
  const r = Router();

  route(
    r,
    {
      method: "get",
      path: "/admin/overview",
      summary: "Provider health, job status counts and queue depth",
      tag: "Admin",
      auth: "admin",
      middleware: [requireAdmin, adminLimiter],
    },
    async () => {
      const [jobCounts, calendarCounts, webhookCounts] = await c.db.asSystem(async (tx) => [
        await tx
          .select({ type: jobs.type, status: jobs.status, n: count() })
          .from(jobs)
          .where(
            sql`${jobs.updatedAt} > now() - interval '7 days' or ${jobs.status} in ('pending','queued','running','failed')`,
          )
          .groupBy(jobs.type, jobs.status),
        await tx
          .select({ status: calendarConnections.status, n: count() })
          .from(calendarConnections)
          .groupBy(calendarConnections.status),
        await tx
          .select({ outcome: webhookEvents.outcome, n: count() })
          .from(webhookEvents)
          .where(sql`${webhookEvents.receivedAt} > now() - interval '24 hours'`)
          .groupBy(webhookEvents.outcome),
      ]);
      const check = async (fn: () => Promise<unknown>) => {
        try {
          await fn();
          return { ok: true };
        } catch (err) {
          return { ok: false, detail: (err as Error).name };
        }
      };
      return {
        providers: {
          meetingBot: c.bot
            ? {
                name: c.bot.name,
                mock: c.bot.isMock,
                ...(await c.bot.healthCheck().catch(() => ({ ok: false }))),
              }
            : null,
          speechToText: c.stt ? { name: c.stt.name, model: c.stt.model, mock: c.stt.isMock } : null,
          llm: c.llm ? { name: c.llm.name, model: c.llm.model, mock: c.llm.isMock } : null,
          storage: { name: c.storage.name, ...(await check(() => c.storage.healthCheck())) },
          database: await check(() => c.db.ping()),
        },
        jobs: jobCounts,
        calendarConnections: calendarCounts,
        webhooksLast24h: webhookCounts,
        queues: queueCounts ? await queueCounts().catch(() => null) : null,
      };
    },
  );

  route(
    r,
    {
      method: "get",
      path: "/admin/jobs",
      summary: "List jobs (safe metadata only)",
      tag: "Admin",
      auth: "admin",
      query: z
        .object({
          status: z
            .enum(["pending", "queued", "running", "succeeded", "failed", "cancelled"])
            .optional(),
          type: z.enum(JOB_TYPES).optional(),
          page: z.coerce.number().int().min(1).max(1000).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(25),
        })
        .strict(),
      middleware: [requireAdmin, adminLimiter],
      responses: {
        200: {
          description: "OK",
          schema: z.object({ items: z.array(AdminJobSchema), total: z.number() }),
        },
      },
    },
    async (_req, _res, { query }) => {
      const conds: SQL[] = [];
      if (query.status) conds.push(eq(jobs.status, query.status));
      if (query.type) conds.push(eq(jobs.type, query.type));
      const where = conds.length ? and(...conds) : undefined;
      return c.db.asSystem(async (tx) => {
        const rows = await tx
          .select()
          .from(jobs)
          .where(where)
          .orderBy(desc(jobs.updatedAt))
          .limit(query.pageSize)
          .offset((query.page - 1) * query.pageSize);
        const [total] = await tx.select({ n: count() }).from(jobs).where(where);
        const items: AdminJob[] = rows.map((j) => ({
          id: j.id,
          type: j.type,
          status: j.status,
          attempts: j.attempts,
          entityId: j.entityId,
          errorCode: j.lastErrorCode,
          runAt: j.runAt.toISOString(),
          updatedAt: j.updatedAt.toISOString(),
        }));
        return { items, total: total?.n ?? 0 };
      });
    },
  );

  route(
    r,
    {
      method: "post",
      path: "/admin/jobs/:jobId/retry",
      summary: "Retry a failed (dead-lettered) job. Handlers are idempotent.",
      tag: "Admin",
      auth: "admin",
      params: uuidParams("jobId"),
      middleware: [requireAdmin, adminLimiter],
    },
    async (req, res, { params }) => {
      const job = await c.db.asSystem(async (tx) => {
        const j = await c.jobs.retryFailed(tx, params.jobId);
        if (j) {
          await c.audit.record(tx, {
            actorType: "admin",
            actorId: req.user!.id,
            action: "admin.job_retried",
            targetType: "job",
            targetId: j.id,
            correlationId: req.requestId,
            metadata: { type: j.type },
          });
        }
        return j;
      });
      if (!job) throw Errors.conflict("not_retryable", "Only failed jobs can be retried");
      res.status(202).json({ status: "pending" });
    },
  );

  return r;
}
