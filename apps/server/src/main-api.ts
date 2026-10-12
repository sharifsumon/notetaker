import { Redis } from "ioredis";
import { createApp } from "./app";
import { loadEnv } from "./config/env";
import { createContainer } from "./container";
import { createLogger } from "./lib/logger";

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL, env.LOG_FORMAT === "pretty");
const container = createContainer(env, logger);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false });
redis.on("error", (err) => logger.warn({ err: err.message }, "redis error"));

const app = createApp(container, { redis });
const server = app.listen(env.PORT, () => {
  logger.info(
    {
      port: env.PORT,
      bot: container.bot?.name ?? "none",
      stt: container.stt?.name ?? "none",
      llm: container.llm?.name ?? "none",
      storage: container.storage.name,
    },
    "API listening",
  );
});
server.requestTimeout = 0; // allow long audio streams; per-route limits apply
server.headersTimeout = 65_000;

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down API");
  server.close();
  await Promise.allSettled([container.db.close(), redis.quit()]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
