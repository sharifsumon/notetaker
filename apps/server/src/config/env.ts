import { z } from "zod";

const bool = (def: boolean) =>
  z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => (v === undefined ? def : v === "true" || v === "1"));

const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(def);

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: int(4000, 1, 65535),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  TRUST_PROXY: int(0, 0, 10),
  /** Public origin of the web app. The API is served under `${PUBLIC_URL}/api`. */
  PUBLIC_URL: z.url().default("http://localhost:5173"),
  /** Public base URL providers use to reach webhooks (defaults to PUBLIC_URL). */
  WEBHOOK_PUBLIC_URL: optionalString,
  ALLOWED_ORIGINS: optionalString,
  DEFAULT_TIMEZONE: z.string().default("UTC"),

  DATABASE_URL: z.string().min(1),
  DATABASE_MIGRATION_URL: optionalString,
  DATABASE_POOL_MAX: int(10, 1, 200),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),

  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  SESSION_TTL_HOURS: int(168, 1),
  SESSION_IDLE_TIMEOUT_HOURS: int(24, 1),
  COOKIE_SECURE: bool(false),

  /** Comma-separated `keyId:base64(32 bytes)` list. */
  TOKEN_ENCRYPTION_KEYS: z.string().min(1),
  TOKEN_ENCRYPTION_ACTIVE_KEY: z.string().min(1),

  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  MICROSOFT_CLIENT_ID: optionalString,
  MICROSOFT_CLIENT_SECRET: optionalString,
  MICROSOFT_TENANT: z.string().default("common"),
  AUTH_DEV_LOGIN_ENABLED: bool(false),

  CALENDAR_SYNC_INTERVAL_MINUTES: int(10, 1, 1440),
  CALENDAR_SYNC_PAST_DAYS: int(14, 0, 365),
  CALENDAR_SYNC_FUTURE_DAYS: int(30, 1, 365),

  MEETING_BOT_PROVIDER: z.enum(["mock", "none"]).default("none"),
  MEETING_BOT_NAME_TEMPLATE: z.string().max(100).default("{name}'s Notetaker (recording)"),
  BOT_JOIN_LEAD_MINUTES: int(2, 0, 60),
  BOT_RECONCILE_GRACE_MINUTES: int(30, 1, 1440),
  MOCK_BOT_WEBHOOK_SECRET: optionalString,
  /** Mock provider event spacing in ms (dev only). */
  MOCK_BOT_STEP_MS: int(3000, 0, 600_000),
  WEBHOOK_TOLERANCE_SECONDS: int(300, 30, 3600),

  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default("./.data/storage"),
  S3_BUCKET: optionalString,
  S3_REGION: optionalString,
  S3_ENDPOINT: optionalString,
  S3_FORCE_PATH_STYLE: bool(false),
  S3_SSE: z.enum(["AES256", "aws:kms"]).default("AES256"),
  S3_KMS_KEY_ID: optionalString,
  SIGNED_URL_TTL_SECONDS: int(60, 10, 900),

  RECORDING_MAX_BYTES: int(1_073_741_824, 1024),
  RECORDING_MAX_DURATION_SECONDS: int(4 * 3600, 60),
  FFMPEG_PATH: z.string().default("ffmpeg"),
  FFPROBE_PATH: z.string().default("ffprobe"),

  STT_PROVIDER: z.enum(["mock", "deepgram", "none"]).default("none"),
  DEEPGRAM_API_KEY: optionalString,
  DEEPGRAM_MODEL: z.string().default("nova-3"),
  STT_LANGUAGE: optionalString,

  LLM_PROVIDER: z.enum(["mock", "anthropic", "none"]).default("none"),
  ANTHROPIC_API_KEY: optionalString,
  LLM_MODEL: z.string().default("claude-sonnet-5-5"),
  LLM_MAX_OUTPUT_TOKENS: int(4096, 256, 64_000),
  LLM_CHUNK_CHARS: int(48_000, 2_000),
  LLM_MAX_TRANSCRIPT_CHARS: int(600_000, 10_000),
  MIN_TRANSCRIPT_WORDS: int(25, 1),
  AUTO_GENERATE_SUMMARY: bool(true),
  AUTO_GENERATE_MINUTES: bool(false),

  /** Days to keep recordings, transcripts and AI artifacts. 0 disables automatic deletion. */
  RETENTION_DAYS: int(90, 0, 3650),
  METRICS_TOKEN: optionalString,
  JOB_MAX_ATTEMPTS: int(5, 1, 20),
});

export type Env = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {}

/** Parses and validates the environment. Fails fast with every problem listed. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new ConfigError(`Invalid environment configuration:\n${lines.join("\n")}`);
  }
  const env = parsed.data;
  const problems: string[] = [];

  if (env.MEETING_BOT_PROVIDER === "mock" && !env.MOCK_BOT_WEBHOOK_SECRET) {
    problems.push("MOCK_BOT_WEBHOOK_SECRET is required when MEETING_BOT_PROVIDER=mock");
  }
  if (env.STT_PROVIDER === "deepgram" && !env.DEEPGRAM_API_KEY) {
    problems.push("DEEPGRAM_API_KEY is required when STT_PROVIDER=deepgram");
  }
  if (env.LLM_PROVIDER === "anthropic" && !env.ANTHROPIC_API_KEY) {
    problems.push("ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic");
  }
  if (env.STORAGE_DRIVER === "s3" && (!env.S3_BUCKET || !env.S3_REGION)) {
    problems.push("S3_BUCKET and S3_REGION are required when STORAGE_DRIVER=s3");
  }
  if ((env.GOOGLE_CLIENT_ID === undefined) !== (env.GOOGLE_CLIENT_SECRET === undefined)) {
    problems.push("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together");
  }
  if ((env.MICROSOFT_CLIENT_ID === undefined) !== (env.MICROSOFT_CLIENT_SECRET === undefined)) {
    problems.push("MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET must be set together");
  }
  const keyIds = env.TOKEN_ENCRYPTION_KEYS.split(",").map((k) => k.split(":")[0]?.trim());
  if (!keyIds.includes(env.TOKEN_ENCRYPTION_ACTIVE_KEY)) {
    problems.push("TOKEN_ENCRYPTION_ACTIVE_KEY must reference a key in TOKEN_ENCRYPTION_KEYS");
  }

  // Production safety rails: never fake recordings/AI output, never allow dev login.
  if (env.NODE_ENV === "production") {
    if (env.MEETING_BOT_PROVIDER === "mock") problems.push("MEETING_BOT_PROVIDER=mock is not allowed in production");
    if (env.STT_PROVIDER === "mock") problems.push("STT_PROVIDER=mock is not allowed in production");
    if (env.LLM_PROVIDER === "mock") problems.push("LLM_PROVIDER=mock is not allowed in production");
    if (env.AUTH_DEV_LOGIN_ENABLED) problems.push("AUTH_DEV_LOGIN_ENABLED is not allowed in production");
    if (!env.COOKIE_SECURE) problems.push("COOKIE_SECURE must be true in production");
    if (!env.PUBLIC_URL.startsWith("https://")) problems.push("PUBLIC_URL must use https in production");
    if (env.SESSION_SECRET.includes("change-me")) problems.push("SESSION_SECRET must be replaced in production");
    if (env.TOKEN_ENCRYPTION_KEYS.includes("REPLACE")) problems.push("TOKEN_ENCRYPTION_KEYS must be replaced in production");
  }
  if (problems.length > 0) {
    throw new ConfigError(`Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  return env;
}

export function webhookBaseUrl(env: Env): string {
  return (env.WEBHOOK_PUBLIC_URL ?? env.PUBLIC_URL).replace(/\/$/, "");
}

export function apiBaseUrl(env: Env): string {
  return `${env.PUBLIC_URL.replace(/\/$/, "")}/api/v1`;
}
