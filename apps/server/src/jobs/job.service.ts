import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { Tx } from "../db/client";
import { jobs, type JobRow } from "../db/schema";

export const JOB_TYPES = [
  "calendar_sync",
  "bot_schedule",
  "bot_cancel",
  "recording_ingest",
  "transcribe",
  "generate_summary",
  "generate_minutes",
  "meeting_delete",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export interface EnqueueInput {
  type: JobType;
  idempotencyKey: string;
  entityId?: string;
  userId?: string | null;
  runAt?: Date;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
}

/** Bounded exponential backoff with jitter (BRD FR-13). */
export function backoffMs(attempt: number, baseMs = 5_000, capMs = 15 * 60_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

/**
 * Durable job records in PostgreSQL are the source of truth for business job status
 * (BRD 9 `jobs`). Rows are written in the same transaction as the domain change
 * (transactional outbox), then dispatched to BullMQ by the worker's dispatcher.
 * The unique idempotency key prevents duplicate jobs from duplicate webhooks/retries.
 */
export class JobService {
  constructor(private readonly defaultMaxAttempts: number) {}

  /** Inserts a job unless one with the same idempotency key exists. Returns the job row. */
  async enqueue(tx: Tx, input: EnqueueInput): Promise<{ job: JobRow; created: boolean }> {
    const inserted = await tx
      .insert(jobs)
      .values({
        type: input.type,
        idempotencyKey: input.idempotencyKey,
        entityId: input.entityId ?? null,
        userId: input.userId ?? null,
        runAt: input.runAt ?? new Date(),
        payload: input.payload ?? {},
        maxAttempts: input.maxAttempts ?? this.defaultMaxAttempts,
      })
      .onConflictDoNothing({ target: jobs.idempotencyKey })
      .returning();
    if (inserted[0]) return { job: inserted[0], created: true };
    const [existing] = await tx.select().from(jobs).where(eq(jobs.idempotencyKey, input.idempotencyKey));
    if (!existing) throw new Error("job enqueue race: row vanished");
    return { job: existing, created: false };
  }

  /** Moves a not-yet-started job to a new run time. Returns false if it already started. */
  async reschedule(tx: Tx, idempotencyKey: string, runAt: Date): Promise<boolean> {
    const r = await tx
      .update(jobs)
      .set({ runAt, updatedAt: new Date() })
      .where(and(eq(jobs.idempotencyKey, idempotencyKey), eq(jobs.status, "pending")))
      .returning({ id: jobs.id });
    return r.length > 0;
  }

  /** Cancels pending jobs for an entity (e.g. a scheduled bot join for a cancelled meeting). */
  async cancelPending(tx: Tx, type: JobType, entityId: string): Promise<number> {
    const r = await tx
      .update(jobs)
      .set({ status: "cancelled", updatedAt: new Date(), completedAt: new Date() })
      .where(and(eq(jobs.type, type), eq(jobs.entityId, entityId), inArray(jobs.status, ["pending", "queued"])))
      .returning({ id: jobs.id });
    return r.length;
  }

  /** Claims due jobs for dispatch (multi-worker safe via SKIP LOCKED). */
  async claimDue(tx: Tx, limit: number, now = new Date()): Promise<JobRow[]> {
    const due = await tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, "pending"), lte(jobs.runAt, now)))
      .orderBy(jobs.runAt)
      .limit(limit)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    await tx
      .update(jobs)
      .set({ status: "queued", updatedAt: now })
      .where(inArray(
        jobs.id,
        due.map((j) => j.id),
      ));
    return due;
  }

  /** Marks a job running and increments attempts. Returns null if it should not run. */
  async start(tx: Tx, jobId: string): Promise<JobRow | null> {
    const [row] = await tx
      .update(jobs)
      .set({ status: "running", attempts: sql`${jobs.attempts} + 1`, updatedAt: new Date() })
      .where(and(eq(jobs.id, jobId), inArray(jobs.status, ["queued", "pending"])))
      .returning();
    return row ?? null;
  }

  async succeed(tx: Tx, jobId: string): Promise<void> {
    await tx
      .update(jobs)
      .set({ status: "succeeded", updatedAt: new Date(), completedAt: new Date(), lastErrorCode: null, lastErrorMessage: null })
      .where(eq(jobs.id, jobId));
  }

  /**
   * Records a failure. Retryable failures with attempts remaining go back to `pending`
   * with backoff; otherwise the job is `failed` (dead-letter, visible to operators).
   */
  async fail(
    tx: Tx,
    job: JobRow,
    errorCode: string,
    message: string,
    retryable: boolean,
  ): Promise<"retry" | "failed"> {
    const canRetry = retryable && job.attempts < job.maxAttempts;
    const now = new Date();
    const retryAt = new Date(now.getTime() + backoffMs(job.attempts));
    await tx
      .update(jobs)
      .set({
        status: canRetry ? "pending" : "failed",
        runAt: canRetry ? retryAt : job.runAt,
        nextRetryAt: canRetry ? retryAt : null,
        lastErrorCode: errorCode,
        lastErrorMessage: message.slice(0, 500),
        updatedAt: now,
        completedAt: canRetry ? null : now,
      })
      .where(eq(jobs.id, job.id));
    return canRetry ? "retry" : "failed";
  }

  /** Re-queues jobs stuck in queued/running beyond the lease (crashed worker). */
  async reapStale(tx: Tx, leaseMs: number, now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - leaseMs);
    const r = await tx
      .update(jobs)
      .set({ status: "pending", updatedAt: now, lastErrorCode: "lease_expired" })
      .where(and(inArray(jobs.status, ["queued", "running"]), lte(jobs.updatedAt, cutoff)))
      .returning({ id: jobs.id });
    return r.length;
  }

  /** Operator retry of a dead-lettered job (FR-15). Safe because handlers are idempotent. */
  async retryFailed(tx: Tx, jobId: string): Promise<JobRow | null> {
    const [row] = await tx
      .update(jobs)
      .set({
        status: "pending",
        runAt: new Date(),
        maxAttempts: sql`${jobs.attempts} + ${this.defaultMaxAttempts}`,
        updatedAt: new Date(),
        completedAt: null,
      })
      .where(and(eq(jobs.id, jobId), eq(jobs.status, "failed")))
      .returning();
    return row ?? null;
  }
}
