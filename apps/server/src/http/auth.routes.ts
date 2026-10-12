import { AuthConfigSchema, MeSchema, UpdateSettingsSchema, type Me } from "@notetaker/shared";
import { Router, type RequestHandler } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { SIGN_IN_SCOPES, type IdentityProvider } from "../auth/oauth";
import { OAUTH_COOKIE } from "../auth/oauth-state";
import type { Container } from "../container";
import { authIdentities, users } from "../db/schema";
import { serialize } from "cookie";
import { Errors, ProviderError } from "../lib/errors";
import { route } from "../lib/http";
import {
  allowedOrigins,
  clearCookie,
  requireUser,
  SESSION_COOKIE,
  sessionCookie,
} from "./middleware";

const ProviderParam = z.object({ provider: z.enum(["google", "microsoft"]) });

export function oauthCookie(c: Container, value: string): string {
  return serialize(OAUTH_COOKIE, value, {
    httpOnly: true,
    secure: c.env.COOKIE_SECURE,
    sameSite: "lax",
    path: "/api/v1",
    maxAge: 600,
  });
}

export function authRoutes(c: Container, authLimiter: RequestHandler): Router {
  const r = Router();
  const base = c.env.PUBLIC_URL.replace(/\/$/, "");
  const devLogin = c.env.AUTH_DEV_LOGIN_ENABLED && c.env.NODE_ENV !== "production";

  route(
    r,
    {
      method: "get",
      path: "/auth/config",
      summary: "Available sign-in methods",
      tag: "Auth",
      auth: "public",
      responses: { 200: { description: "OK", schema: AuthConfigSchema } },
    },
    () => ({ googleAuth: !!c.oauth.google, microsoftAuth: !!c.oauth.microsoft, devLogin }),
  );

  route(
    r,
    {
      method: "get",
      path: "/auth/:provider",
      summary: "Start sign-in with Google or Microsoft (redirect)",
      tag: "Auth",
      auth: "public",
      params: ProviderParam,
      query: z.object({ link: z.enum(["1"]).optional() }),
      middleware: [authLimiter],
      responses: { 302: { description: "Redirect to identity provider" } },
    },
    (_req, res, { params, query }) => {
      const client = c.oauth[params.provider];
      if (!client) throw Errors.notConfigured(`${params.provider} sign-in`);
      const linkUser = query.link === "1" ? _req.user?.id : undefined;
      const { st, cookie, challenge } = c.oauthState.create("login", params.provider, linkUser);
      res.setHeader("Set-Cookie", oauthCookie(c, cookie));
      res.redirect(
        302,
        client.buildAuthorizationUrl({
          redirectUri: `${base}/api/v1/auth/${params.provider}/callback`,
          scopes: SIGN_IN_SCOPES[params.provider],
          state: st.state,
          nonce: st.nonce,
          codeChallenge: challenge,
          offline: false,
        }),
      );
    },
  );

  route(
    r,
    {
      method: "get",
      path: "/auth/:provider/callback",
      summary: "OAuth/OIDC sign-in callback",
      tag: "Auth",
      auth: "public",
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
      const fail = (code: string) => {
        res.setHeader("Set-Cookie", clearCookie(c, OAUTH_COOKIE, "/api/v1"));
        res.redirect(302, `${base}/login?error=${encodeURIComponent(code)}`);
      };
      const st = c.oauthState.read(req.cookies[OAUTH_COOKIE]);
      if (query.error) return fail("access_denied");
      if (
        !st ||
        st.purpose !== "login" ||
        st.provider !== params.provider ||
        !query.state ||
        st.state !== query.state ||
        !query.code
      ) {
        return fail("invalid_state");
      }
      const client = c.oauth[params.provider as IdentityProvider];
      if (!client) return fail("not_configured");
      try {
        const tokens = await client.exchangeCode(
          query.code,
          `${base}/api/v1/auth/${params.provider}/callback`,
          st.verifier,
          SIGN_IN_SCOPES[params.provider],
        );
        if (!tokens.idToken) return fail("invalid_token");
        const identity = await client.verifyIdToken(tokens.idToken, st.nonce);
        // Sign-in tokens are not stored: only calendar connections keep tokens (FR-01).
        const user = await c.auth.resolveUser(params.provider, identity, {
          linkToUserId: st.userId && req.user?.id === st.userId ? st.userId : undefined,
          correlationId: req.requestId,
        });
        const s = await c.sessions.create(user.id, req.header("user-agent"));
        res.setHeader("Set-Cookie", [
          clearCookie(c, OAUTH_COOKIE, "/api/v1"),
          sessionCookie(c, s.token, s.expiresAt),
        ]);
        res.redirect(302, `${base}/${user.recordingNoticeAcknowledgedAt ? "" : "onboarding"}`);
      } catch (err) {
        req.log.warn({ code: err instanceof ProviderError ? err.code : "error" }, "sign-in failed");
        return fail(err instanceof ProviderError ? err.code : "sign_in_failed");
      }
    },
  );

  route(
    r,
    {
      method: "post",
      path: "/auth/dev-login",
      summary: "DEVELOPMENT ONLY: sign in as a local test user (disabled in production)",
      tag: "Auth",
      auth: "public",
      body: z
        .object({ email: z.email().max(200), displayName: z.string().trim().min(1).max(120) })
        .strict(),
      middleware: [authLimiter],
    },
    async (req, res, { body }) => {
      if (!devLogin) throw Errors.notFound("Route");
      const origin = req.header("origin");
      if (origin && !allowedOrigins(c).has(origin)) throw Errors.csrf();
      const email = body.email.toLowerCase();
      const user = await c.auth.resolveUser(
        "dev",
        {
          subject: `dev:${email}`,
          tenant: null,
          email,
          emailVerified: false,
          name: body.displayName,
        },
        { correlationId: req.requestId },
      );
      const s = await c.sessions.create(user.id, req.header("user-agent"));
      res.setHeader("Set-Cookie", sessionCookie(c, s.token, s.expiresAt));
      res.status(204).end();
    },
  );

  route(
    r,
    {
      method: "post",
      path: "/auth/logout",
      summary: "Sign out (revokes this session)",
      tag: "Auth",
      auth: "user",
      middleware: [requireUser],
    },
    async (req, res) => {
      if (req.sessionId) await c.sessions.revoke(req.sessionId);
      await c.db.asSystem((tx) =>
        c.audit.record(tx, {
          actorType: "user",
          actorId: req.user!.id,
          action: "auth.sign_out",
          targetType: "user",
          targetId: req.user!.id,
          correlationId: req.requestId,
        }),
      );
      res.setHeader("Set-Cookie", clearCookie(c, SESSION_COOKIE));
      res.status(204).end();
    },
  );

  route(
    r,
    {
      method: "post",
      path: "/auth/logout-all",
      summary: "Sign out of all sessions",
      tag: "Auth",
      auth: "user",
      middleware: [requireUser],
    },
    async (req, res) => {
      await c.sessions.revokeAllForUser(req.user!.id);
      await c.db.asSystem((tx) =>
        c.audit.record(tx, {
          actorType: "user",
          actorId: req.user!.id,
          action: "auth.sign_out_all",
          targetType: "user",
          targetId: req.user!.id,
          correlationId: req.requestId,
        }),
      );
      res.setHeader("Set-Cookie", clearCookie(c, SESSION_COOKIE));
      res.status(204).end();
    },
  );

  const toMe = async (userId: string, csrfToken: string): Promise<Me> => {
    const { u, ids } = await c.db.asSystem(async (tx) => {
      const [u] = await tx.select().from(users).where(eq(users.id, userId));
      const ids = await tx
        .select({ provider: authIdentities.provider, email: authIdentities.emailAtProvider })
        .from(authIdentities)
        .where(eq(authIdentities.userId, userId));
      return { u: u!, ids };
    });
    return {
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      timezone: u.timezone,
      role: u.role,
      autoRegister: u.autoRegister,
      recordingNoticeAcknowledgedAt: u.recordingNoticeAcknowledgedAt?.toISOString() ?? null,
      identities: ids,
      csrfToken,
      features: {
        devLogin,
        googleAuth: !!c.oauth.google,
        microsoftAuth: !!c.oauth.microsoft,
        mockProviders: !!(c.bot?.isMock || c.stt?.isMock || c.llm?.isMock),
      },
    };
  };

  route(
    r,
    {
      method: "get",
      path: "/me",
      summary: "Current user, settings and CSRF token",
      tag: "Account",
      auth: "user",
      middleware: [requireUser],
      responses: { 200: { description: "OK", schema: MeSchema } },
    },
    async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      return toMe(req.user!.id, req.csrfToken!);
    },
  );

  route(
    r,
    {
      method: "patch",
      path: "/me/settings",
      summary: "Update timezone, auto-registration preference, or acknowledge the recording notice",
      tag: "Account",
      auth: "user",
      body: UpdateSettingsSchema,
      middleware: [requireUser],
      responses: { 200: { description: "OK", schema: MeSchema } },
    },
    async (req, _res, { body }) => {
      const userId = req.user!.id;
      await c.db.asSystem(async (tx) => {
        const [u] = await tx.select().from(users).where(eq(users.id, userId));
        if (
          body.autoRegister === true &&
          !u?.recordingNoticeAcknowledgedAt &&
          !body.acknowledgeRecordingNotice
        ) {
          throw Errors.conflict(
            "recording_notice_required",
            "Acknowledge the recording notice before enabling automatic recording",
          );
        }
        await tx
          .update(users)
          .set({
            ...(body.timezone ? { timezone: body.timezone } : {}),
            ...(body.displayName ? { displayName: body.displayName } : {}),
            ...(body.autoRegister !== undefined ? { autoRegister: body.autoRegister } : {}),
            ...(body.acknowledgeRecordingNotice
              ? { recordingNoticeAcknowledgedAt: new Date() }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(users.id, userId));
        await c.audit.record(tx, {
          actorType: "user",
          actorId: userId,
          action: "settings.updated",
          targetType: "user",
          targetId: userId,
          correlationId: req.requestId,
          metadata: {
            autoRegister: body.autoRegister,
            acknowledgedRecordingNotice: body.acknowledgeRecordingNotice ?? undefined,
            timezoneChanged: body.timezone !== undefined,
          },
        });
      });
      return toMe(userId, req.csrfToken!);
    },
  );

  return r;
}
