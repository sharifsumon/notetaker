import express, { Router, type Express, type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import type { Redis } from "ioredis";
import { RedisStore, type RedisReply } from "rate-limit-redis";
import swaggerUi from "swagger-ui-express";
import { count, sql } from "drizzle-orm";
import type { Container } from "./container";
import { jobs } from "./db/schema";
import { adminRoutes } from "./http/admin.routes";
import { authRoutes } from "./http/auth.routes";
import { calendarRoutes } from "./http/calendar.routes";
import { meetingRoutes } from "./http/meetings.routes";
import {
  allowedOrigins,
  csrfProtection,
  errorHandler,
  limiter,
  notFoundHandler,
  requestContext,
  sessionLoader,
} from "./http/middleware";
import { buildOpenApi } from "./http/openapi";
import { webhookRoutes } from "./http/webhooks.routes";
import { safeEqual } from "./lib/crypto";

export interface AppOptions {
  redis?: Redis | null;
  queueCounts?: () => Promise<unknown>;
  version?: string;
}

export function createApp(c: Container, opts: AppOptions = {}): Express {
  const app = express();
  app.disable("x-powered-by");
  if (c.env.TRUST_PROXY > 0) app.set("trust proxy", c.env.TRUST_PROXY);

  app.use(
    helmet({
      // API responses are JSON/audio; the web app's CSP is set by its own server (nginx).
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: "same-origin" },
      hsts: c.env.NODE_ENV === "production",
    }),
  );
  app.use(requestContext(c.logger, c.metrics));

  // CORS: same-origin by default; only explicitly allowed origins get credentialed CORS.
  const origins = allowedOrigins(c);
  app.use((req, res, next) => {
    const origin = req.header("origin");
    if (origin && origins.has(origin) && origin !== new URL(c.env.PUBLIC_URL).origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token, Idempotency-Key");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE");
      res.setHeader("Vary", "Origin");
      if (req.method === "OPTIONS") return void res.status(204).end();
    }
    next();
  });

  // Health (unauthenticated, no sensitive data).
  app.get("/api/v1/health/live", (_req, res) => void res.json({ status: "ok" }));
  app.get("/api/v1/health/ready", async (_req, res) => {
    const checks: Record<string, boolean> = {};
    await Promise.all([
      c.db.ping().then(() => (checks.database = true), () => (checks.database = false)),
      opts.redis
        ? opts.redis.ping().then(() => (checks.redis = true), () => (checks.redis = false))
        : Promise.resolve((checks.redis = true)),
      c.storage.healthCheck().then(() => (checks.storage = true), () => (checks.storage = false)),
    ]);
    const ok = Object.values(checks).every(Boolean);
    res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "degraded", checks });
  });

  // Prometheus metrics (protect with METRICS_TOKEN; do not expose publicly via the proxy).
  app.get("/metrics", async (req, res) => {
    if (c.env.METRICS_TOKEN) {
      const auth = req.header("authorization") ?? "";
      if (!safeEqual(auth, `Bearer ${c.env.METRICS_TOKEN}`)) return void res.status(401).end();
    } else if (c.env.NODE_ENV === "production") {
      return void res.status(404).end();
    }
    try {
      const rows = await c.db.asSystem((tx) =>
        tx.select({ status: jobs.status, n: count() }).from(jobs).where(sql`${jobs.status} in ('pending','queued','running','failed')`).groupBy(jobs.status),
      );
      c.metrics.jobQueueDepth.reset();
      for (const r of rows) c.metrics.jobQueueDepth.set({ status: r.status }, r.n);
    } catch {
      /* metrics still served */
    }
    res.setHeader("Content-Type", c.metrics.registry.contentType);
    res.end(await c.metrics.registry.metrics());
  });

  const store = opts.redis
    ? (prefix: string) => () =>
        new RedisStore({
          prefix: `rl:${prefix}:`,
          sendCommand: (command: string, ...args: string[]) =>
            opts.redis!.call(command, ...args) as Promise<RedisReply>,
        })
    : () => undefined;
  const authLimiter = limiter({ windowMs: 60_000, limit: 20, keyBy: "ip", name: "auth" }, store("auth"));
  const registration = limiter({ windowMs: 60_000, limit: 30, keyBy: "user", name: "reg" }, store("reg"));
  const generation = limiter({ windowMs: 60_000, limit: 10, keyBy: "user", name: "gen" }, store("gen"));
  const download = limiter({ windowMs: 60_000, limit: 120, keyBy: "user", name: "dl" }, store("dl"));
  const admin = limiter({ windowMs: 60_000, limit: 60, keyBy: "user", name: "admin" }, store("admin"));
  const webhook = limiter({ windowMs: 60_000, limit: 1200, keyBy: "ip", name: "wh" }, store("wh"));

  const api = Router();
  // Webhooks need the raw body for signature verification: mounted before the JSON parser.
  api.use(webhookRoutes(c, webhook));
  api.use(express.json({ limit: "100kb" }));
  api.use(sessionLoader(c));
  api.use(csrfProtection(c));
  api.use(authRoutes(c, authLimiter));
  api.use(calendarRoutes(c, authLimiter));
  api.use(meetingRoutes(c, { registration, generation, download }));
  api.use(adminRoutes(c, admin, opts.queueCounts));

  const doc = buildOpenApi(opts.version ?? "0.1.0");
  api.get("/openapi.json", (_req, res) => void res.json(doc));
  if (c.env.NODE_ENV !== "production") {
    app.use(
      "/api/docs",
      (_req: Request, res: Response, next: NextFunction) => {
        // Swagger UI needs inline assets; relax CSP for this dev-only page.
        res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:");
        next();
      },
      swaggerUi.serve,
      swaggerUi.setup(doc),
    );
  }

  app.use("/api/v1", api);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
