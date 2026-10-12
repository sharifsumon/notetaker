import { loadEnv } from "./config/env";
import { createContainer } from "./container";
import { createLogger } from "./lib/logger";
import { startWorker } from "./worker";

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL, env.NODE_ENV === "development");
const container = createContainer(env, logger);
const metricsPort = process.env.WORKER_METRICS_PORT ? Number(process.env.WORKER_METRICS_PORT) : undefined;
const worker = startWorker(container, env.REDIS_URL, metricsPort);

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down worker");
  await worker.stop();
  await container.db.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
