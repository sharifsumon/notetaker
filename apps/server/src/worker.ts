import { createServer, type Server } from "node:http";
import type { Container } from "./container";
import { BullDispatcher } from "./jobs/runner";

export interface WorkerHandle {
  dispatcher: BullDispatcher;
  stop(): Promise<void>;
}

/**
 * Background worker process: dispatches durable jobs to BullMQ, executes them, and runs
 * periodic maintenance (calendar sync scheduling, bot reconciliation, stale-job reaping,
 * retention). All periodic work is idempotent so multiple replicas are safe.
 */
export function startWorker(c: Container, redisUrl: string, metricsPort?: number): WorkerHandle {
  const url = new URL(redisUrl);
  const connection = {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    tls: url.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null,
  };
  const dispatcher = new BullDispatcher(connection, c.db, c.jobs, c.runner, c.logger);
  dispatcher.start(1000);

  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, name: string, fn: () => Promise<unknown>) => {
    const run = () =>
      fn().catch((err: Error) =>
        c.logger.error({ task: name, err: err.message }, "periodic task failed"),
      );
    timers.push(setInterval(run, ms));
    setTimeout(run, 2_000);
  };
  every(c.env.CALENDAR_SYNC_INTERVAL_MINUTES * 60_000, "calendar_sync", () =>
    c.calendar.enqueueDueSyncs(),
  );
  every(5 * 60_000, "bot_reconcile", () => c.botService.reconcile());
  every(60_000, "reap_stale_jobs", () => c.db.asSystem((tx) => c.jobs.reapStale(tx, 90 * 60_000)));
  every(60 * 60_000, "retention", () => c.deletion.enqueueRetention());

  let server: Server | null = null;
  if (metricsPort) {
    server = createServer(async (req, res) => {
      if (req.url === "/metrics") {
        res.setHeader("Content-Type", c.metrics.registry.contentType);
        res.end(await c.metrics.registry.metrics());
      } else if (req.url === "/health") {
        res.end("ok");
      } else {
        res.statusCode = 404;
        res.end();
      }
    }).listen(metricsPort);
  }

  c.logger.info(
    { bot: c.bot?.name ?? "none", stt: c.stt?.name ?? "none", llm: c.llm?.name ?? "none" },
    "worker started",
  );
  return {
    dispatcher,
    async stop() {
      for (const t of timers) clearInterval(t);
      server?.close();
      await dispatcher.close();
    },
  };
}
