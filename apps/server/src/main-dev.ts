/**
 * Development convenience: runs the API and the worker in one process with auto-migrate.
 * Production runs them as separate processes (main-api / main-worker).
 */
import { Redis } from "ioredis";
import { createApp } from "./app";
import { loadEnv } from "./config/env";
import { createContainer } from "./container";
import { runMigrations } from "./db/migrate";
import { createLogger } from "./lib/logger";
import { startWorker } from "./worker";

const env = loadEnv();
if (env.NODE_ENV === "production") throw new Error("main-dev must not be used in production");
const logger = createLogger(env.LOG_LEVEL, true);

await runMigrations(env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL);
const container = createContainer(env, logger);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
const worker = startWorker(container, env.REDIS_URL);
const app = createApp(container, { redis, queueCounts: () => worker.dispatcher.queueCounts() });
app.listen(env.PORT, () => logger.info({ port: env.PORT }, "dev API + worker listening"));
