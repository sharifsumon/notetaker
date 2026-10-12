import { InvalidTransitionError } from "@notetaker/shared";
import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { eq } from "drizzle-orm";
import { ReauthRequiredError } from "../auth/oauth";
import type { Db } from "../db/client";
import { jobs, type JobRow } from "../db/schema";
import { AppError, PermanentJobError, ProviderError } from "../lib/errors";
import type { Logger } from "../lib/logger";
import type { Metrics } from "../metrics";
import type { JobService, JobType } from "./job.service";

export interface JobHandler {
  run(job: JobRow): Promise<void>;
  /** Called once when a job is dead-lettered, to reflect the failure in domain status. */
  onFinalFailure?(job: JobRow, code: string): Promise<void>;
}

export type HandlerMap = Partial<Record<JobType, JobHandler>>;

export function classifyError(err: unknown): { code: string; retryable: boolean; message: string } {
  if (err instanceof ProviderError)
    return { code: err.code, retryable: err.retryable, message: err.message };
  if (err instanceof PermanentJobError)
    return { code: err.code, retryable: false, message: err.message };
  if (err instanceof ReauthRequiredError)
    return { code: "calendar_reconnect_required", retryable: false, message: err.message };
  if (err instanceof InvalidTransitionError)
    return { code: "invalid_transition", retryable: false, message: err.message };
  if (err instanceof AppError)
    return { code: err.code, retryable: err.status >= 500, message: err.message };
  return {
    code: "internal_error",
    retryable: true,
    message: err instanceof Error ? err.name : "unknown",
  };
}

const QUEUE_FOR: Record<JobType, "realtime" | "media" | "ai"> = {
  calendar_sync: "realtime",
  bot_schedule: "realtime",
  bot_cancel: "realtime",
  meeting_delete: "realtime",
  recording_ingest: "media",
  transcribe: "media",
  generate_summary: "ai",
  generate_minutes: "ai",
};

/**
 * Executes durable jobs. PostgreSQL holds business status/attempts/backoff; BullMQ
 * distributes execution across worker processes with per-queue concurrency.
 */
export class JobRunner {
  constructor(
    private readonly db: Db,
    private readonly jobService: JobService,
    private readonly handlers: HandlerMap,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
  ) {}

  async execute(jobId: string): Promise<"succeeded" | "retry" | "failed" | "skipped"> {
    const job = await this.db.asSystem((tx) => this.jobService.start(tx, jobId));
    if (!job) return "skipped";
    const handler = this.handlers[job.type as JobType];
    const log = this.logger.child({ jobId: job.id, jobType: job.type, attempt: job.attempts });
    const end = this.metrics.jobDuration.startTimer({ type: job.type });
    try {
      if (!handler) throw new PermanentJobError("no_handler", `No handler for ${job.type}`);
      await handler.run(job);
      await this.db.asSystem((tx) => this.jobService.succeed(tx, job.id));
      this.metrics.jobsProcessed.inc({ type: job.type, outcome: "succeeded" });
      log.info("job succeeded");
      return "succeeded";
    } catch (err) {
      const c = classifyError(err);
      const outcome = await this.db.asSystem((tx) =>
        this.jobService.fail(tx, job, c.code, c.message, c.retryable),
      );
      this.metrics.jobsProcessed.inc({ type: job.type, outcome });
      log.warn(
        { code: c.code, retryable: c.retryable, outcome, errName: (err as Error)?.name },
        "job failed",
      );
      if (outcome === "failed" && handler?.onFinalFailure) {
        await handler
          .onFinalFailure(job, c.code)
          .catch((e: Error) => log.error({ err: e.message }, "onFinalFailure error"));
      }
      return outcome;
    } finally {
      end();
    }
  }

  /** Synchronous drain used by tests and the dev single-process mode without Redis. */
  async drain(maxRounds = 50): Promise<number> {
    let executed = 0;
    for (let i = 0; i < maxRounds; i++) {
      const due = await this.db.asSystem((tx) => this.jobService.claimDue(tx, 50));
      if (due.length === 0) break;
      for (const j of due) {
        await this.execute(j.id);
        executed++;
      }
    }
    return executed;
  }
}

/** Moves due jobs from PostgreSQL to BullMQ queues and processes them. */
export class BullDispatcher {
  private readonly queues: Record<"realtime" | "media" | "ai", Queue>;
  private readonly workers: Worker[] = [];
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly connection: ConnectionOptions,
    private readonly db: Db,
    private readonly jobService: JobService,
    private readonly runner: JobRunner,
    private readonly logger: Logger,
    private readonly concurrency = { realtime: 10, media: 2, ai: 4 },
  ) {
    this.queues = {
      realtime: new Queue("notetaker-realtime", { connection }),
      media: new Queue("notetaker-media", { connection }),
      ai: new Queue("notetaker-ai", { connection }),
    };
  }

  start(pollMs = 1000): void {
    for (const name of ["realtime", "media", "ai"] as const) {
      const w = new Worker(
        `notetaker-${name}`,
        async (bj) => {
          await this.runner.execute((bj.data as { jobId: string }).jobId);
        },
        { connection: this.connection, concurrency: this.concurrency[name] },
      );
      w.on("error", (err) =>
        this.logger.error({ err: err.message, queue: name }, "bullmq worker error"),
      );
      this.workers.push(w);
    }
    this.timer = setInterval(() => void this.tick(), pollMs);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const due = await this.db.asSystem((tx) => this.jobService.claimDue(tx, 100));
      for (const job of due) {
        try {
          await this.queues[QUEUE_FOR[job.type as JobType] ?? "realtime"].add(
            job.type,
            { jobId: job.id },
            {
              jobId: `${job.id}-${job.attempts}`,
              removeOnComplete: 1000,
              removeOnFail: 1000,
              attempts: 1,
            },
          );
        } catch (err) {
          this.logger.error(
            { jobId: job.id, err: (err as Error).message },
            "dispatch failed; returning job to pending",
          );
          await this.db.asSystem((tx) =>
            tx.update(jobs).set({ status: "pending" }).where(eq(jobs.id, job.id)),
          );
        }
      }
    } catch (err) {
      this.logger.error({ err: (err as Error).message }, "dispatcher tick failed");
    } finally {
      this.running = false;
    }
  }

  async queueCounts(): Promise<Record<string, Record<string, number>>> {
    const out: Record<string, Record<string, number>> = {};
    for (const [name, q] of Object.entries(this.queues))
      out[name] = await q.getJobCounts("waiting", "active", "delayed", "failed");
    return out;
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.all(Object.values(this.queues).map((q) => q.close()));
  }
}
