/** Writes the OpenAPI document to docs/openapi.json (no database needed). */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../app";
import { loadEnv } from "../config/env";
import { createContainer } from "../container";
import { Db } from "../db/client";
import { buildOpenApi } from "../http/openapi";
import { createLogger } from "../lib/logger";

const env = loadEnv({
  NODE_ENV: "development",
  DATABASE_URL: "postgres://unused/unused",
  SESSION_SECRET: "openapi-generation-secret-not-used-anywhere",
  TOKEN_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32).toString("base64")}`,
  TOKEN_ENCRYPTION_ACTIVE_KEY: "k1",
});
const logger = createLogger("silent");
const c = createContainer(env, logger, { db: new Db(env.DATABASE_URL, 1) });
createApp(c); // registers routes
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../docs/openapi.json");
writeFileSync(out, `${JSON.stringify(buildOpenApi("0.1.0"), null, 2)}\n`);
console.log(`Wrote ${out}`);
await c.db.close();
