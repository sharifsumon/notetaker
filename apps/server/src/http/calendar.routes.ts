import { CALENDAR_PROVIDERS, CalendarConnectionSchema } from "@notetaker/shared";
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { CALENDAR_SCOPES } from "../auth/oauth";
import { OAUTH_COOKIE } from "../auth/oauth-state";
import { CALENDAR_TO_IDP } from "../calendar/calendar.service";
import type { Container } from "../container";
import { AppError, Errors, ProviderError } from "../lib/errors";
import { route, uuidParams } from "../lib/http";
import { oauthCookie } from "./auth.routes";
import { clearCookie, requireUser } from "./middleware";

const ProviderParam = z.object({ provider: z.enum(CALENDAR_PROVIDERS) });

export function calendarRoutes(c: Container, authLimiter: RequestHandler): Router {
  const r = Router();
  const base = c.env.PUBLIC_URL.replace(/\/$/, "");
  const redirectUri = (p: string) => `${base}/api/v1/calendar-connections/${p}/callback`;

  route(
    r,
    {
      method: "get",
      path: "/calendar-connections",
      summary: "List calendar connections",
      tag: "Calendar",
      auth: "user",
      middleware: [requireUser],
      responses: {
        200: {
          description: "OK",
          schema: z.object({
            items: z.array(CalendarConnectionSchema),
            available: z.array(z.enum(CALENDAR_PROVIDERS)),
          }),
        },
      },
    },
    async (req) => ({
      items: await c.calendar.list(req.user!.id),
      available: CALENDAR_PROVIDERS.filter((p) => c.calendar.isConfigured(p)),
    }),
  );

  route(
    r,
    {
      method: "post",
      path: "/calendar-connections/:provider/connect",
      summary:
        "Start calendar authorization (separate consent from sign-in). Returns the URL to navigate to.",
      tag: "Calendar",
      auth: "user",
      params: ProviderParam,
      middleware: [requireUser, authLimiter],
      responses: { 200: { description: "OK", schema: z.object({ authorizationUrl: z.string() }) } },
    },
    (req, res, { params }) => {
      if (!c.calendar.isConfigured(params.provider))
        throw Errors.notConfigured("This calendar provider");
      const client = c.oauth[CALENDAR_TO_IDP[params.provider]]!;
      const { st, cookie, challenge } = c.oauthState.create(
        "calendar",
        params.provider,
        req.user!.id,
      );
      res.setHeader("Set-Cookie", oauthCookie(c, cookie));
      return {
        authorizationUrl: client.buildAuthorizationUrl({
          redirectUri: redirectUri(params.provider),
          scopes: CALENDAR_SCOPES[CALENDAR_TO_IDP[params.provider]],
          state: st.state,
          nonce: st.nonce,
          codeChallenge: challenge,
          offline: true,
          loginHint: req.user!.email ?? undefined,
        }),
      };
    },
  );

  route(
    r,
    {
      method: "get",
      path: "/calendar-connections/:provider/callback",
      summary: "Calendar OAuth callback",
      tag: "Calendar",
      auth: "user",
      params: ProviderParam,
      query: z
        .object({
          code: z.string().max(4096).optional(),
          state: z.string().max(512).optional(),
          error: z.string().max(200).optional(),
        })
        .loose(),
      middleware: [authLimiter],
    },
    async (req, res, { params, query }) => {
      const done = (status: string) => {
        res.setHeader("Set-Cookie", clearCookie(c, OAUTH_COOKIE, "/api/v1"));
        res.redirect(302, `${base}/settings?calendar=${encodeURIComponent(status)}`);
      };
      if (!req.user) return res.redirect(302, `${base}/login?error=session_expired`);
      const st = c.oauthState.read(req.cookies[OAUTH_COOKIE]);
      if (query.error) return done("denied");
      if (
        !st ||
        st.purpose !== "calendar" ||
        st.provider !== params.provider ||
        st.userId !== req.user.id ||
        st.state !== query.state ||
        !query.code
      ) {
        return done("invalid_state");
      }
      const client = c.oauth[CALENDAR_TO_IDP[params.provider]];
      if (!client) return done("not_configured");
      try {
        const scopes = CALENDAR_SCOPES[CALENDAR_TO_IDP[params.provider]];
        const tokens = await client.exchangeCode(
          query.code,
          redirectUri(params.provider),
          st.verifier,
          scopes,
        );
        if (!tokens.idToken) return done("invalid_token");
        const identity = await client.verifyIdToken(tokens.idToken, st.nonce);
        await c.calendar.saveConnection(
          req.user.id,
          params.provider,
          tokens,
          { subject: identity.subject, email: identity.email },
          req.requestId,
        );
        return done("connected");
      } catch (err) {
        req.log.warn(
          { code: err instanceof ProviderError || err instanceof AppError ? err.code : "error" },
          "calendar connect failed",
        );
        return done(err instanceof AppError ? err.code : "failed");
      }
    },
  );

  route(
    r,
    {
      method: "delete",
      path: "/calendar-connections/:id",
      summary: "Disconnect a calendar (revokes and deletes tokens)",
      tag: "Calendar",
      auth: "user",
      params: uuidParams("id"),
      middleware: [requireUser],
    },
    async (req, res, { params }) => {
      await c.calendar.disconnect(req.user!.id, params.id, req.requestId);
      res.status(204).end();
    },
  );

  route(
    r,
    {
      method: "post",
      path: "/calendar-connections/:id/sync",
      summary: "Request an immediate sync",
      tag: "Calendar",
      auth: "user",
      params: uuidParams("id"),
      middleware: [requireUser],
    },
    async (req, res, { params }) => {
      await c.calendar.requestSync(req.user!.id, params.id);
      res.status(202).json({ status: "queued" });
    },
  );

  return r;
}
