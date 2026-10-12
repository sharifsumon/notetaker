import { randomUUID } from "node:crypto";
import { parse as parseCookies, serialize } from "cookie";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { rateLimit, type Store } from "express-rate-limit";
import { InvalidTransitionError } from "@notetaker/shared";
import type { Container } from "../container";
import type { User } from "../db/schema";
import { safeEqual } from "../lib/crypto";
import { AppError, Errors } from "../lib/errors";
import type { Logger } from "../lib/logger";

export const SESSION_COOKIE = "nt_session";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      log: Logger;
      cookies: Record<string, string | undefined>;
      user?: User;
      sessionId?: string;
      csrfToken?: string;
    }
  }
}

export function requestContext(logger: Logger, metrics: Container["metrics"]): RequestHandler {
  return (req, res, next) => {
    const incoming = req.header("x-request-id");
    req.requestId = incoming && /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader("X-Request-Id", req.requestId);
    req.log = logger.child({ requestId: req.requestId });
    req.cookies = parseCookies(req.headers.cookie ?? "");
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const routePath = (req.route as { path?: string } | undefined)?.path ?? "unmatched";
      metrics.httpDuration.observe(
        { method: req.method, route: `${req.baseUrl}${routePath}`, status: res.statusCode },
        ms / 1000,
      );
      // Log path without query string (queries may contain search terms).
      req.log.info(
        {
          method: req.method,
          path: req.baseUrl + (req.route ? routePath : ""),
          status: res.statusCode,
          ms: Math.round(ms),
        },
        "request",
      );
    });
    next();
  };
}

export function sessionLoader(c: Container): RequestHandler {
  return async (req, _res, next) => {
    try {
      const token = req.cookies[SESSION_COOKIE];
      if (token) {
        const ctx = await c.sessions.resolve(token);
        if (ctx) {
          req.user = ctx.user;
          req.sessionId = ctx.sessionId;
          req.csrfToken = ctx.csrfToken;
          req.log = req.log.child({ userId: ctx.user.id });
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function allowedOrigins(c: Container): Set<string> {
  const set = new Set([new URL(c.env.PUBLIC_URL).origin]);
  for (const o of (c.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean))
    set.add(o);
  return set;
}

/**
 * CSRF protection for cookie sessions: state-changing requests must carry the per-session
 * token in `X-CSRF-Token`, and any Origin header must be an allowed origin.
 */
export function csrfProtection(c: Container): RequestHandler {
  const origins = allowedOrigins(c);
  return (req, _res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    if (req.path.startsWith("/webhooks/")) return next(); // authenticated by signature instead
    const origin = req.header("origin");
    if (origin && !origins.has(origin)) return next(Errors.csrf());
    if (!req.user) return next(); // unauthenticated endpoints handle their own checks
    const header = req.header("x-csrf-token") ?? "";
    if (!req.csrfToken || !safeEqual(header, req.csrfToken)) return next(Errors.csrf());
    next();
  };
}

export const requireUser: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(Errors.unauthenticated());
  next();
};

export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(Errors.unauthenticated());
  if (req.user.role !== "admin") return next(Errors.forbidden());
  next();
};

export function sessionCookie(c: Container, value: string, expires: Date): string {
  return serialize(SESSION_COOKIE, value, {
    httpOnly: true,
    secure: c.env.COOKIE_SECURE,
    sameSite: "lax",
    path: "/",
    expires,
  });
}

export function clearCookie(c: Container, name: string, path = "/"): string {
  return serialize(name, "", {
    httpOnly: true,
    secure: c.env.COOKIE_SECURE,
    sameSite: "lax",
    path,
    maxAge: 0,
  });
}

export function limiter(
  opts: { windowMs: number; limit: number; keyBy: "ip" | "user"; name: string },
  store?: () => Store,
): RequestHandler {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    store: store?.(),
    keyGenerator: (req) =>
      `${opts.name}:${opts.keyBy === "user" && req.user ? req.user.id : (req.ip ?? "unknown")}`,
    handler: (_req, _res, next) => next(Errors.rateLimited()),
    validate: { keyGeneratorIpFallback: false },
  });
}

export function notFoundHandler(_req: Request, _res: Response, next: NextFunction): void {
  next(Errors.notFound("Route"));
}

/** Central error handler: consistent envelope, no internals leaked. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  let appErr: AppError;
  if (err instanceof AppError) appErr = err;
  else if (err instanceof InvalidTransitionError) {
    appErr = new AppError(
      409,
      "invalid_state",
      "This action is not allowed in the meeting's current state",
    );
  } else if ((err as { type?: string }).type === "entity.too.large") {
    appErr = new AppError(413, "payload_too_large", "Request body too large");
  } else if ((err as { type?: string }).type === "entity.parse.failed") {
    appErr = Errors.badRequest("Malformed JSON body");
  } else {
    req.log?.error(
      {
        err: {
          name: (err as Error)?.name,
          message: (err as Error)?.message,
          stack: (err as Error)?.stack,
        },
      },
      "unhandled error",
    );
    appErr = new AppError(500, "internal_error", "An unexpected error occurred");
  }
  if (appErr.status >= 500 && appErr.code !== "internal_error")
    req.log?.warn({ code: appErr.code }, "server error");
  if (res.headersSent) return;
  res.status(appErr.status).json({
    error: {
      code: appErr.code,
      message: appErr.message,
      requestId: req.requestId,
      ...(appErr.details ? { details: appErr.details } : {}),
    },
  });
}
