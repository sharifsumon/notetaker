import supertest from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, login, resetDb } from "./helpers";

const ctx = createTestContext();
afterAll(() => ctx.close());
beforeEach(() => resetDb());

describe("authentication & sessions", () => {
  it("requires authentication for private endpoints", async () => {
    const res = await supertest(ctx.app).get("/api/v1/me").expect(401);
    expect(res.body.error.code).toBe("unauthenticated");
    expect(res.body.error.requestId).toBeTruthy();
    await supertest(ctx.app).get("/api/v1/meetings").expect(401);
  });

  it("signs in, returns the profile and CSRF token, and signs out (session revoked)", async () => {
    const u = await login(ctx.app, "alice@example.com");
    const me = await u.agent.get("/api/v1/me").expect(200);
    expect(me.body.email).toBe("alice@example.com");
    expect(me.body.csrfToken).toBe(u.csrf);
    expect(me.headers["cache-control"]).toBe("no-store");

    await u.agent.post("/api/v1/auth/logout").set("x-csrf-token", u.csrf).expect(204);
    await u.agent.get("/api/v1/me").expect(401);
  });

  it("sets a HttpOnly SameSite session cookie", async () => {
    const res = await supertest(ctx.app)
      .post("/api/v1/auth/dev-login")
      .send({ email: "c@example.com", displayName: "C" })
      .expect(204);
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toMatch(/nt_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it("rejects state-changing requests without a valid CSRF token", async () => {
    const u = await login(ctx.app, "bob@example.com");
    const r1 = await u.agent.patch("/api/v1/me/settings").send({ timezone: "UTC" }).expect(403);
    expect(r1.body.error.code).toBe("csrf_failed");
    await u.agent
      .patch("/api/v1/me/settings")
      .set("x-csrf-token", "wrong")
      .send({ timezone: "UTC" })
      .expect(403);
    await u.agent
      .patch("/api/v1/me/settings")
      .set("x-csrf-token", u.csrf)
      .send({ timezone: "UTC" })
      .expect(200);
  });

  it("rejects cross-origin state-changing requests", async () => {
    const u = await login(ctx.app, "eve@example.com");
    await u.agent
      .patch("/api/v1/me/settings")
      .set("x-csrf-token", u.csrf)
      .set("origin", "https://evil.example")
      .send({ timezone: "UTC" })
      .expect(403);
  });

  it("logout-all revokes every session of the user", async () => {
    const a = await login(ctx.app, "multi@example.com");
    const b = await login(ctx.app, "multi@example.com", { acknowledge: false });
    await a.agent.post("/api/v1/auth/logout-all").set("x-csrf-token", a.csrf).expect(204);
    await b.agent.get("/api/v1/me").expect(401);
  });

  it("validates settings input", async () => {
    const u = await login(ctx.app, "tz@example.com");
    const r = await u.agent
      .patch("/api/v1/me/settings")
      .set("x-csrf-token", u.csrf)
      .send({ timezone: "Mars/Olympus" })
      .expect(400);
    expect(r.body.error.code).toBe("validation_error");
    await u.agent
      .patch("/api/v1/me/settings")
      .set("x-csrf-token", u.csrf)
      .send({ role: "admin" })
      .expect(400);
  });

  it("requires acknowledging the recording notice before enabling auto-recording", async () => {
    const u = await login(ctx.app, "auto@example.com", { acknowledge: false });
    const r = await u.agent
      .patch("/api/v1/me/settings")
      .set("x-csrf-token", u.csrf)
      .send({ autoRegister: true })
      .expect(409);
    expect(r.body.error.code).toBe("recording_notice_required");
    const ok = await u.agent
      .patch("/api/v1/me/settings")
      .set("x-csrf-token", u.csrf)
      .send({ autoRegister: true, acknowledgeRecordingNotice: true })
      .expect(200);
    expect(ok.body.autoRegister).toBe(true);
    expect(ok.body.recordingNoticeAcknowledgedAt).toBeTruthy();
  });

  it("does not expose OAuth routes when providers are not configured", async () => {
    const cfg = await supertest(ctx.app).get("/api/v1/auth/config").expect(200);
    expect(cfg.body).toEqual({ googleAuth: false, microsoftAuth: false, devLogin: true });
    const r = await supertest(ctx.app).get("/api/v1/auth/google").expect(503);
    expect(r.body.error.code).toBe("not_configured");
  });
});

describe("dev login is disabled unless explicitly enabled", () => {
  const off = createTestContext({ AUTH_DEV_LOGIN_ENABLED: "false" });
  afterAll(() => off.close());
  it("returns 404", async () => {
    await supertest(off.app)
      .post("/api/v1/auth/dev-login")
      .send({ email: "x@example.com", displayName: "X" })
      .expect(404);
  });
});
