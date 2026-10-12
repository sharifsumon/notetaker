import { pino, type Logger } from "pino";

/**
 * Structured logger with redaction. Tokens, cookies, signed URLs, meeting URLs and
 * meeting content must never reach logs (BRD 8.3, 12).
 */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-csrf-token']",
  "res.headers['set-cookie']",
  "*.accessToken",
  "*.refreshToken",
  "*.access_token",
  "*.refresh_token",
  "*.id_token",
  "*.idToken",
  "*.token",
  "*.password",
  "*.secret",
  "*.apiKey",
  "*.signedUrl",
  "*.downloadUrl",
  "*.meetingUrl",
  "*.meeting_url",
  "*.transcript",
  "*.content",
  "*.text",
];

export function createLogger(level: string, pretty = false): Logger {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    base: { service: "notetaker" },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty ? { transport: { target: "pino-pretty", options: { colorize: true } } } : {}),
  });
}

export type { Logger };
