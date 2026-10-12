import { describe, expect, it } from "vitest";
import { ConfigError, loadEnv } from "./env";

const base = {
  DATABASE_URL: "postgres://x/y",
  SESSION_SECRET: "a-very-long-session-secret-value-123456",
  TOKEN_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 3).toString("base64")}`,
  TOKEN_ENCRYPTION_ACTIVE_KEY: "k1",
};

describe("environment validation", () => {
  it("applies secure defaults (no providers enabled)", () => {
    const env = loadEnv(base);
    expect(env.MEETING_BOT_PROVIDER).toBe("none");
    expect(env.LLM_PROVIDER).toBe("none");
    expect(env.AUTH_DEV_LOGIN_ENABLED).toBe(false);
  });

  it("lists all problems at once", () => {
    expect(() => loadEnv({})).toThrow(ConfigError);
    try {
      loadEnv({});
    } catch (e) {
      expect((e as Error).message).toMatch(/DATABASE_URL/);
      expect((e as Error).message).toMatch(/SESSION_SECRET/);
    }
  });

  it("requires credentials for configured providers", () => {
    expect(() => loadEnv({ ...base, LLM_PROVIDER: "anthropic" })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => loadEnv({ ...base, STT_PROVIDER: "deepgram" })).toThrow(/DEEPGRAM_API_KEY/);
    expect(() => loadEnv({ ...base, MEETING_BOT_PROVIDER: "mock" })).toThrow(/MOCK_BOT_WEBHOOK_SECRET/);
    expect(() => loadEnv({ ...base, GOOGLE_CLIENT_ID: "x" })).toThrow(/set together/);
  });

  it("refuses mock providers, dev login and insecure cookies in production", () => {
    const prod = { ...base, NODE_ENV: "production", PUBLIC_URL: "https://notes.example.com", COOKIE_SECURE: "true" };
    expect(() => loadEnv(prod)).not.toThrow();
    expect(() => loadEnv({ ...prod, MEETING_BOT_PROVIDER: "mock", MOCK_BOT_WEBHOOK_SECRET: "s" })).toThrow(/mock is not allowed/);
    expect(() => loadEnv({ ...prod, STT_PROVIDER: "mock" })).toThrow(/not allowed in production/);
    expect(() => loadEnv({ ...prod, LLM_PROVIDER: "mock" })).toThrow(/not allowed in production/);
    expect(() => loadEnv({ ...prod, AUTH_DEV_LOGIN_ENABLED: "true" })).toThrow(/AUTH_DEV_LOGIN_ENABLED/);
    expect(() => loadEnv({ ...prod, COOKIE_SECURE: "false" })).toThrow(/COOKIE_SECURE/);
    expect(() => loadEnv({ ...prod, PUBLIC_URL: "http://notes.example.com" })).toThrow(/https/);
  });
});
