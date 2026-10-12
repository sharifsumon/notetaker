import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import supertest from "supertest";
import { inject } from "vitest";
import { createApp } from "../src/app";
import { MockMeetingBotProvider } from "../src/bot/mock-provider";
import { loadEnv, type Env } from "../src/config/env";
import { createContainer, type Overrides } from "../src/container";
import { Db } from "../src/db/client";
import { createLogger } from "../src/lib/logger";
import { LocalStorageAdapter } from "../src/storage/local";

export const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
export const WEBHOOK_SECRET = "test-webhook-secret";

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    PUBLIC_URL: "http://localhost:5173",
    DATABASE_URL: inject("dbAppUrl"),
    SESSION_SECRET: "test-session-secret-at-least-32-characters",
    TOKEN_ENCRYPTION_KEYS: `k1:${TEST_KEY}`,
    TOKEN_ENCRYPTION_ACTIVE_KEY: "k1",
    AUTH_DEV_LOGIN_ENABLED: "true",
    MEETING_BOT_PROVIDER: "mock",
    MOCK_BOT_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STT_PROVIDER: "mock",
    LLM_PROVIDER: "mock",
    BOT_JOIN_LEAD_MINUTES: "0",
    ...overrides,
  });
}

export const ownerPool = () => new pg.Pool({ connectionString: inject("dbOwnerUrl"), max: 2 });

/** Truncates all application tables (as the owner, bypassing nothing: TRUNCATE ignores RLS). */
export async function resetDb(): Promise<void> {
  const pool = ownerPool();
  await pool.query(`TRUNCATE users, auth_identities, sessions, calendar_connections, meetings, meeting_participants,
    recordings, transcripts, meeting_artifacts, meeting_status_events, webhook_events, jobs, audit_events CASCADE`);
  await pool.end();
}

export type TestContext = ReturnType<typeof createTestContext>;

export function createTestContext(envOverrides: Record<string, string> = {}, o: Overrides = {}) {
  const env = testEnv(envOverrides);
  const logger = createLogger("silent");
  const storageDir = mkdtempSync(path.join(tmpdir(), "notetaker-test-storage-"));
  const db = new Db(env.DATABASE_URL, 5);
  const c = createContainer(env, logger, {
    db,
    storage: new LocalStorageAdapter(storageDir),
    emitMockWebhooks: false,
    ...o,
  });
  const app = createApp(c);
  return { env, c, app, storageDir, close: () => db.close() };
}

export interface LoggedIn {
  agent: ReturnType<typeof supertest.agent>;
  csrf: string;
  userId: string;
}

/** Signs in through the dev-login endpoint and returns an agent with session cookie + CSRF token. */
export async function login(
  app: TestContext["app"],
  email: string,
  opts: { acknowledge?: boolean } = { acknowledge: true },
): Promise<LoggedIn> {
  const agent = supertest.agent(app);
  await agent.post("/api/v1/auth/dev-login").send({ email, displayName: email.split("@")[0] }).expect(204);
  const me = await agent.get("/api/v1/me").expect(200);
  const csrf = me.body.csrfToken as string;
  if (opts.acknowledge !== false) {
    await agent.patch("/api/v1/me/settings").set("x-csrf-token", csrf).send({ acknowledgeRecordingNotice: true }).expect(200);
  }
  return { agent, csrf, userId: me.body.id as string };
}

/** Delivers a correctly signed mock-provider webhook. */
export function sendWebhook(
  ctx: TestContext,
  payload: { type: string; session_id: string; error_code?: string | null; participant?: { id: string; name: string } | null },
  opts: { eventId?: string; timestamp?: number; secretOverride?: string } = {},
) {
  const eventId = opts.eventId ?? `evt_${Math.random().toString(36).slice(2)}`;
  const body = JSON.stringify({ event_id: eventId, occurred_at: new Date().toISOString(), error_code: null, ...payload });
  const ts = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const signer = opts.secretOverride
    ? new MockMeetingBotProvider({ webhookSecret: opts.secretOverride, stepMs: 0, ffmpegPath: "ffmpeg", logger: createLogger("silent"), emitWebhooks: false })
    : (ctx.c.bot as MockMeetingBotProvider);
  const headers = signer.sign(eventId, body, ts);
  return supertest(ctx.app).post("/api/v1/webhooks/meeting-provider/mock").set(headers).send(body);
}

export function futureIso(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export async function registerAdhoc(u: LoggedIn, title: string, startInMinutes = 30, url = "https://meet.google.com/abc-defg-hij") {
  const res = await u.agent
    .post("/api/v1/meetings/register")
    .set("x-csrf-token", u.csrf)
    .send({ title, meetingUrl: url, startAt: futureIso(startInMinutes), endAt: futureIso(startInMinutes + 60) });
  return res;
}
