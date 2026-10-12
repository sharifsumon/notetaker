import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Platform } from "@notetaker/shared";
import { hmacSha256Hex, randomToken, safeEqual } from "../lib/crypto";
import type { Logger } from "../lib/logger";
import {
  WebhookVerificationError,
  type CreateSessionInput,
  type MeetingBotProvider,
  type ProviderEvent,
  type ProviderEventType,
  type ProviderSessionState,
  type RecordingAssetResult,
} from "./types";

const execFileAsync = promisify(execFile);

export const MOCK_SCENARIOS = [
  "success",
  "admission-timeout",
  "denied",
  "no-recording",
  "duplicate-webhooks",
  "out-of-order",
  "empty-transcript",
  "short-transcript",
] as const;
export type MockScenario = (typeof MOCK_SCENARIOS)[number];

/** Dev/test only: scenario chosen from a `[mock:<scenario>]` tag in the meeting title. */
export function mockScenarioFromTitle(title: string): MockScenario {
  const m = /\[mock:([a-z-]+)\]/i.exec(title);
  const s = m?.[1]?.toLowerCase();
  return (MOCK_SCENARIOS as readonly string[]).includes(s ?? "") ? (s as MockScenario) : "success";
}

interface SessionInfo {
  m: string; // meeting id
  j: number; // join at (ms)
  c: number; // created at (ms)
  s: MockScenario;
}

function encodeSession(info: SessionInfo): string {
  return `mock_${Buffer.from(JSON.stringify(info)).toString("base64url")}.${randomToken(6)}`;
}

function decodeSession(sessionId: string): SessionInfo | null {
  const m = /^mock_([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/.exec(sessionId);
  if (!m?.[1]) return null;
  try {
    return JSON.parse(Buffer.from(m[1], "base64url").toString("utf8")) as SessionInfo;
  } catch {
    return null;
  }
}

export interface MockProviderOptions {
  webhookSecret: string;
  stepMs: number;
  ffmpegPath: string;
  logger: Logger;
  /** When false, no webhooks are emitted (tests drive events explicitly). */
  emitWebhooks: boolean;
  fetchImpl?: typeof fetch;
}

/**
 * DEVELOPMENT/TEST mock of a meeting-bot provider. It simulates the lifecycle with
 * signed webhooks and serves a generated test tone as the "recording".
 * It never joins a real meeting and is refused by configuration in production.
 */
export class MockMeetingBotProvider implements MeetingBotProvider {
  readonly name = "mock";
  readonly isMock = true;
  private readonly cancelled = new Set<string>();
  private readonly timers = new Map<string, NodeJS.Timeout[]>();

  constructor(private readonly opts: MockProviderOptions) {}

  supportsPlatform(_platform: Platform): boolean {
    return true;
  }

  async createSession(input: CreateSessionInput): Promise<{ sessionId: string }> {
    const scenario = (MOCK_SCENARIOS as readonly string[]).includes(input.mockScenario ?? "")
      ? (input.mockScenario as MockScenario)
      : "success";
    const sessionId = encodeSession({
      m: input.meetingId,
      j: input.joinAt.getTime(),
      c: Date.now(),
      s: scenario,
    });
    if (this.opts.emitWebhooks) this.scheduleWebhooks(sessionId, input.webhookUrl);
    return { sessionId };
  }

  /** Timeline offsets (ms after join) per scenario. */
  private timeline(
    scenario: MockScenario,
  ): Array<{ at: number; type: ProviderEventType; errorCode?: string }> {
    const s = this.opts.stepMs;
    switch (scenario) {
      case "admission-timeout":
        return [
          { at: 0, type: "bot.joining" },
          { at: s, type: "bot.waiting_for_admission" },
          { at: 3 * s, type: "bot.failed", errorCode: "bot_admission_timeout" },
        ];
      case "denied":
        return [
          { at: 0, type: "bot.joining" },
          { at: s, type: "bot.waiting_for_admission" },
          { at: 2 * s, type: "bot.failed", errorCode: "bot_denied_admission" },
        ];
      case "out-of-order":
        return [
          { at: 0, type: "bot.in_call_recording" },
          { at: s / 2, type: "bot.joining" },
          { at: 3 * s, type: "bot.call_ended" },
          { at: 4 * s, type: "bot.recording_ready" },
        ];
      default:
        return [
          { at: 0, type: "bot.joining" },
          { at: s, type: "bot.waiting_for_admission" },
          { at: 2 * s, type: "bot.in_call_recording" },
          { at: 2 * s + s / 2, type: "bot.participant_joined" },
          { at: 5 * s, type: "bot.call_ended" },
          { at: 6 * s, type: "bot.recording_ready" },
        ];
    }
  }

  private scheduleWebhooks(sessionId: string, webhookUrl: string): void {
    const info = decodeSession(sessionId)!;
    const base = Math.max(info.j, Date.now());
    const handles: NodeJS.Timeout[] = [];
    for (const step of this.timeline(info.s)) {
      const delay = Math.min(Math.max(0, base + step.at - Date.now()), 2_000_000_000);
      handles.push(
        setTimeout(() => {
          if (this.cancelled.has(sessionId)) return;
          const times = info.s === "duplicate-webhooks" ? 2 : 1;
          const eventId = `evt_${randomToken(10)}`;
          for (let i = 0; i < times; i++) {
            void this.deliver(webhookUrl, eventId, {
              event_id: eventId,
              type: step.type,
              session_id: sessionId,
              occurred_at: new Date().toISOString(),
              error_code: step.errorCode ?? null,
              participant:
                step.type === "bot.participant_joined"
                  ? { id: "p1", name: "Test Participant" }
                  : null,
            });
          }
        }, delay),
      );
    }
    this.timers.set(sessionId, handles);
  }

  /** Signs a payload exactly like `verifyAndParseWebhook` expects (also used by tests). */
  sign(eventId: string, body: string, timestampSec: number): Record<string, string> {
    const sig = hmacSha256Hex(this.opts.webhookSecret, `${eventId}.${timestampSec}.${body}`);
    return {
      "content-type": "application/json",
      "x-mock-event-id": eventId,
      "x-mock-timestamp": String(timestampSec),
      "x-mock-signature": `v1=${sig}`,
    };
  }

  private async deliver(
    url: string,
    eventId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const body = JSON.stringify(payload);
    const headers = this.sign(eventId, body, Math.floor(Date.now() / 1000));
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(url, { method: "POST", headers, body });
      if (!res.ok)
        this.opts.logger.warn(
          { status: res.status, eventType: payload.type },
          "mock webhook rejected",
        );
    } catch (err) {
      this.opts.logger.warn({ err: (err as Error).message }, "mock webhook delivery failed");
    }
  }

  async getSession(sessionId: string): Promise<ProviderSessionState> {
    const info = decodeSession(sessionId);
    if (!info) return { status: "failed", errorCode: "provider_error" };
    if (this.cancelled.has(sessionId)) return { status: "cancelled" };
    const elapsed = Date.now() - Math.max(info.j, info.c);
    if (elapsed < 0) return { status: "scheduled" };
    const passed = this.timeline(info.s).filter((e) => e.at <= elapsed);
    const last = passed[passed.length - 1];
    switch (last?.type) {
      case undefined:
        return { status: "scheduled" };
      case "bot.failed":
        return { status: "failed", errorCode: last.errorCode ?? "provider_error" };
      case "bot.recording_ready":
        return { status: "done" };
      case "bot.call_ended":
        return { status: "call_ended" };
      case "bot.in_call_recording":
      case "bot.participant_joined":
        return { status: "in_call_recording" };
      case "bot.waiting_for_admission":
        return { status: "waiting_for_admission" };
      default:
        return { status: "joining" };
    }
  }

  async cancelSession(sessionId: string): Promise<void> {
    this.cancelled.add(sessionId);
    for (const t of this.timers.get(sessionId) ?? []) clearTimeout(t);
    this.timers.delete(sessionId);
  }

  async getRecording(sessionId: string): Promise<RecordingAssetResult> {
    const info = decodeSession(sessionId);
    if (!info) return { status: "unavailable", errorCode: "recording_unavailable" };
    if (info.s === "no-recording" || info.s === "admission-timeout" || info.s === "denied") {
      return { status: "unavailable", errorCode: "recording_unavailable" };
    }
    const file = await this.ensureFixtureAudio();
    const size = (await stat(file)).size;
    return {
      status: "ready",
      providerAssetId: `asset_${info.m}`,
      mimeType: "audio/wav",
      expectedSizeBytes: size,
      recordedAt: new Date(Math.max(info.j, info.c)),
      open: async () => createReadStream(file),
    };
  }

  /** Generates a short synthetic audio file (test tone) once per process. */
  private fixturePromise: Promise<string> | null = null;
  ensureFixtureAudio(): Promise<string> {
    this.fixturePromise ??= (async () => {
      const dir = path.join(tmpdir(), "notetaker-mock");
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, "mock-recording.wav");
      try {
        await stat(file);
        return file;
      } catch {
        await execFileAsync(this.opts.ffmpegPath, [
          "-y",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=12:sample_rate=16000",
          "-ac",
          "1",
          file,
        ]);
        return file;
      }
    })();
    return this.fixturePromise;
  }

  verifyAndParseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
    now: Date,
  ): ProviderEvent[] {
    const eventId = headers["x-mock-event-id"];
    const ts = headers["x-mock-timestamp"];
    const sig = headers["x-mock-signature"];
    if (!eventId || !ts || !sig) throw new WebhookVerificationError("missing_headers");
    if (!/^\d{1,12}$/.test(ts)) throw new WebhookVerificationError("malformed");
    const expected = `v1=${hmacSha256Hex(this.opts.webhookSecret, `${eventId}.${ts}.${rawBody.toString("utf8")}`)}`;
    if (!safeEqual(expected, sig)) throw new WebhookVerificationError("bad_signature");
    const ageSec = Math.abs(now.getTime() / 1000 - Number(ts));
    if (ageSec > this.toleranceSec) throw new WebhookVerificationError("stale");

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new WebhookVerificationError("malformed");
    }
    const type = body.type;
    const sessionId = body.session_id;
    if (typeof type !== "string" || typeof sessionId !== "string" || body.event_id !== eventId) {
      throw new WebhookVerificationError("malformed");
    }
    const allowed: ProviderEventType[] = [
      "bot.joining",
      "bot.waiting_for_admission",
      "bot.in_call_recording",
      "bot.call_ended",
      "bot.recording_ready",
      "bot.failed",
      "bot.participant_joined",
    ];
    if (!allowed.includes(type as ProviderEventType))
      throw new WebhookVerificationError("malformed");
    const occurred = typeof body.occurred_at === "string" ? new Date(body.occurred_at) : now;
    const participant = body.participant as { id?: unknown; name?: unknown } | null | undefined;
    return [
      {
        eventId,
        type: type as ProviderEventType,
        sessionId,
        occurredAt: Number.isNaN(occurred.getTime()) ? now : occurred,
        errorCode: typeof body.error_code === "string" ? body.error_code : null,
        participant:
          participant && typeof participant.id === "string" && typeof participant.name === "string"
            ? { id: participant.id, name: participant.name.slice(0, 200) }
            : null,
      },
    ];
  }

  toleranceSec = 300;

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: "mock provider (development only)" };
  }

  shutdown(): void {
    for (const handles of this.timers.values()) for (const t of handles) clearTimeout(t);
    this.timers.clear();
  }
}
