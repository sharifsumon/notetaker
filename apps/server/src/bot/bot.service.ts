import { canTransition, type MeetingStatus } from "@notetaker/shared";
import { and, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { AuditService } from "../audit/audit.service";
import type { Db, Tx } from "../db/client";
import { meetingParticipants, meetings, users, webhookEvents, type Meeting } from "../db/schema";
import { PermanentJobError } from "../lib/errors";
import type { Logger } from "../lib/logger";
import type { JobService } from "../jobs/job.service";
import type { Metrics } from "../metrics";
import { effectiveEnd, type MeetingService } from "../meetings/meeting.service";
import { mockScenarioFromTitle } from "./mock-provider";
import { normalizeFailureCode, type MeetingBotProvider, type ProviderEvent, type ProviderSessionState } from "./types";

export interface BotServiceDeps {
  db: Db;
  provider: MeetingBotProvider | null;
  meetings: MeetingService;
  jobs: JobService;
  audit: AuditService;
  logger: Logger;
  metrics: Metrics;
  webhookUrl: (provider: string) => string;
  botNameTemplate: string;
  reconcileGraceMinutes: number;
  now?: () => Date;
}

export type EventOutcome = "applied" | "duplicate" | "unknown_session" | "ignored_invalid_transition" | "no_change";

export class BotService {
  private readonly now: () => Date;

  constructor(private readonly d: BotServiceDeps) {
    this.now = d.now ?? (() => new Date());
  }

  private get provider(): MeetingBotProvider {
    if (!this.d.provider) throw new PermanentJobError("provider_unavailable", "No meeting bot provider configured");
    return this.d.provider;
  }

  botName(displayName: string): string {
    const first = displayName.trim().split(/\s+/)[0] || "Meeting";
    return this.d.botNameTemplate.replace("{name}", first).slice(0, 100);
  }

  /** Job: create the provider session for a queued meeting (idempotent). */
  async schedule(meetingId: string): Promise<void> {
    const provider = this.provider;
    const loaded = await this.d.db.asSystem(async (tx) => {
      const [m] = await tx.select().from(meetings).where(and(eq(meetings.id, meetingId), isNull(meetings.deletedAt)));
      if (!m || m.status !== "queued" || m.providerSessionId) return null;
      const [u] = await tx.select({ displayName: users.displayName }).from(users).where(eq(users.id, m.userId));
      if (!provider.supportsPlatform(m.platform)) {
        await this.d.meetings.transition(tx, m, "failed", {
          source: "scheduler",
          reasonCode: "unsupported_platform",
          patch: { failureCode: "unsupported_platform" },
        });
        return null;
      }
      if (effectiveEnd(m).getTime() <= this.now().getTime()) {
        await this.d.meetings.transition(tx, m, "failed", {
          source: "scheduler",
          reasonCode: "meeting_ended",
          patch: { failureCode: "bot_join_failed" },
        });
        return null;
      }
      return { m, url: this.d.meetings.decryptUrl(m), displayName: u?.displayName ?? "Meeting" };
    });
    if (!loaded?.url) return;
    const { m } = loaded;

    const { sessionId } = await provider.createSession({
      meetingId: m.id,
      meetingUrl: loaded.url,
      platform: m.platform,
      joinAt: m.scheduledStartAt,
      botName: this.botName(loaded.displayName),
      webhookUrl: this.d.webhookUrl(provider.name),
      mockScenario: provider.isMock ? mockScenarioFromTitle(m.title) : null,
    });

    const stillQueued = await this.d.db.asSystem(async (tx) => {
      const r = await tx
        .update(meetings)
        .set({ providerSessionId: sessionId, botProvider: provider.name, updatedAt: this.now() })
        .where(and(eq(meetings.id, m.id), eq(meetings.status, "queued"), isNull(meetings.providerSessionId)))
        .returning({ id: meetings.id });
      if (r.length > 0) {
        await this.d.audit.record(tx, {
          actorType: "system",
          action: "bot.session_created",
          targetType: "meeting",
          targetId: m.id,
          metadata: { provider: provider.name, sessionId },
        });
      }
      return r.length > 0;
    });
    if (!stillQueued) {
      // Meeting was cancelled/deleted while we were creating the session: undo it.
      await provider.cancelSession(sessionId).catch(() => undefined);
    }
  }

  /** Job: cancel a provider session. */
  async cancel(sessionId: string): Promise<void> {
    await this.provider.cancelSession(sessionId);
  }

  /**
   * Applies authenticated provider events. Idempotent: each event id is stored in the
   * webhook inbox (unique), so duplicate deliveries are no-ops. Out-of-order events that
   * would cause an invalid transition are recorded and ignored.
   */
  async applyEvent(providerName: string, ev: ProviderEvent): Promise<EventOutcome> {
    return this.d.db.asSystem(async (tx) => {
      const inserted = await tx
        .insert(webhookEvents)
        .values({
          provider: providerName,
          eventId: ev.eventId,
          eventType: ev.type,
          sessionId: ev.sessionId,
          payload: { errorCode: ev.errorCode ?? null, occurredAt: ev.occurredAt.toISOString() },
        })
        .onConflictDoNothing()
        .returning({ id: webhookEvents.id });
      if (inserted.length === 0) return "duplicate";
      const inboxId = inserted[0]!.id;

      const [m] = await tx
        .select()
        .from(meetings)
        .where(and(eq(meetings.botProvider, providerName), eq(meetings.providerSessionId, ev.sessionId)))
        .for("update");
      let outcome: EventOutcome;
      if (!m || m.deletedAt) outcome = "unknown_session";
      else outcome = await this.applyToMeeting(tx, m, ev);

      await tx
        .update(webhookEvents)
        .set({ processedAt: this.now(), outcome })
        .where(eq(webhookEvents.id, inboxId));
      if (outcome !== "applied") {
        this.d.logger.info({ provider: providerName, eventType: ev.type, outcome }, "provider event not applied");
      }
      return outcome;
    });
  }

  private async tryTransition(
    tx: Tx,
    m: Meeting,
    to: MeetingStatus,
    reason: string | null,
    patch: Partial<typeof meetings.$inferInsert> = {},
  ): Promise<Meeting | null> {
    if (!canTransition(m.status as MeetingStatus, to)) return null;
    return this.d.meetings.transition(tx, m, to, { source: "provider", reasonCode: reason, patch });
  }

  private async enqueueIngest(tx: Tx, m: Meeting): Promise<void> {
    await this.d.jobs.enqueue(tx, {
      type: "recording_ingest",
      idempotencyKey: `recording_ingest:${m.id}:${m.providerSessionId}`,
      entityId: m.id,
      userId: m.userId,
      maxAttempts: 12,
    });
  }

  private async applyToMeeting(tx: Tx, m: Meeting, ev: ProviderEvent): Promise<EventOutcome> {
    const status = m.status as MeetingStatus;
    switch (ev.type) {
      case "bot.joining":
        return (await this.tryTransition(tx, m, "joining", null, { substatus: null })) ? "applied" : "ignored_invalid_transition";
      case "bot.waiting_for_admission": {
        if (status === "joining") {
          await tx.update(meetings).set({ substatus: "waiting_for_admission", updatedAt: this.now() }).where(eq(meetings.id, m.id));
          return "applied";
        }
        return (await this.tryTransition(tx, m, "joining", "waiting_for_admission", { substatus: "waiting_for_admission" }))
          ? "applied"
          : "ignored_invalid_transition";
      }
      case "bot.in_call_recording":
        return (await this.tryTransition(tx, m, "in_progress", null, { substatus: null, actualStartAt: ev.occurredAt }))
          ? "applied"
          : "ignored_invalid_transition";
      case "bot.call_ended": {
        const t = await this.tryTransition(tx, m, "recording_processing", null, { actualEndAt: ev.occurredAt });
        if (!t) return "ignored_invalid_transition";
        await this.enqueueIngest(tx, t);
        return "applied";
      }
      case "bot.recording_ready": {
        let current = m;
        if (status === "in_progress") {
          current = (await this.tryTransition(tx, m, "recording_processing", null, { actualEndAt: ev.occurredAt })) ?? m;
        }
        if (current.status !== "recording_processing") return "ignored_invalid_transition";
        await this.enqueueIngest(tx, current);
        return "applied";
      }
      case "bot.failed": {
        const code = normalizeFailureCode(ev.errorCode);
        const t = await this.tryTransition(tx, m, "failed", code, { failureCode: code, substatus: null });
        if (!t) return "ignored_invalid_transition";
        this.d.metrics.botJoinFailures.inc({ provider: m.botProvider ?? "unknown", code });
        return "applied";
      }
      case "bot.participant_joined": {
        if (!ev.participant) return "no_change";
        await tx
          .insert(meetingParticipants)
          .values({
            userId: m.userId,
            meetingId: m.id,
            displayName: ev.participant.name,
            source: "provider",
            sourceKey: ev.participant.id.slice(0, 200),
            joinedAt: ev.occurredAt,
          })
          .onConflictDoNothing();
        return "applied";
      }
    }
  }

  /** Converts a polled provider state into synthetic events (used when webhooks are missed). */
  static stateToEvents(sessionId: string, state: ProviderSessionState, at: Date): ProviderEvent[] {
    const mk = (type: ProviderEvent["type"], errorCode?: string | null): ProviderEvent => ({
      eventId: `reconcile:${sessionId}:${type}`,
      type,
      sessionId,
      occurredAt: at,
      errorCode: errorCode ?? null,
    });
    switch (state.status) {
      case "joining":
        return [mk("bot.joining")];
      case "waiting_for_admission":
        return [mk("bot.waiting_for_admission")];
      case "in_call_recording":
        return [mk("bot.in_call_recording")];
      case "call_ended":
        return [mk("bot.in_call_recording"), mk("bot.call_ended")];
      case "done":
        return [mk("bot.in_call_recording"), mk("bot.call_ended"), mk("bot.recording_ready")];
      case "failed":
        return [mk("bot.failed", state.errorCode)];
      default:
        return [];
    }
  }

  /**
   * Periodic reconciliation: polls the provider for active sessions whose meeting should
   * have progressed (missed webhooks, provider outage). Never fabricates success: it only
   * applies states the provider itself reports.
   */
  async reconcile(): Promise<number> {
    if (!this.d.provider) return 0;
    const provider = this.d.provider;
    const cutoff = new Date(this.now().getTime() - 10 * 60_000);
    const stale = await this.d.db.asSystem((tx) =>
      tx
        .select()
        .from(meetings)
        .where(
          and(
            inArray(meetings.status, ["queued", "joining", "in_progress"]),
            isNotNull(meetings.providerSessionId),
            eq(meetings.botProvider, provider.name),
            isNull(meetings.deletedAt),
            lt(meetings.updatedAt, cutoff),
            lt(meetings.scheduledStartAt, this.now()),
          ),
        )
        .limit(100),
    );
    let applied = 0;
    for (const m of stale) {
      try {
        const state = await provider.getSession(m.providerSessionId!);
        for (const ev of BotService.stateToEvents(m.providerSessionId!, state, this.now())) {
          if ((await this.applyEvent(provider.name, ev)) === "applied") applied++;
        }
        // Long past the end and the provider still has no outcome: surface a failure.
        const graceEnd = effectiveEnd(m).getTime() + this.d.reconcileGraceMinutes * 60_000;
        if (state.status === "scheduled" && this.now().getTime() > graceEnd) {
          await this.applyEvent(provider.name, {
            eventId: `reconcile:${m.providerSessionId}:timeout`,
            type: "bot.failed",
            sessionId: m.providerSessionId!,
            occurredAt: this.now(),
            errorCode: "bot_join_failed",
          });
        }
      } catch (err) {
        this.d.logger.warn({ meetingId: m.id, err: (err as Error).message }, "reconcile failed");
      }
    }
    // Recordings stuck in processing with no ingest job progress are retried by jobs themselves.
    return applied;
  }

  /** Marks queued meetings whose bot_schedule job exhausted retries as failed. */
  async markScheduleFailed(meetingId: string, code: string): Promise<void> {
    await this.d.db.asSystem(async (tx) => {
      const [m] = await tx.select().from(meetings).where(eq(meetings.id, meetingId)).for("update");
      if (m && m.status === "queued") {
        await this.d.meetings.transition(tx, m, "failed", {
          source: "scheduler",
          reasonCode: code,
          patch: { failureCode: code === "provider_unavailable" ? "provider_unavailable" : "bot_join_failed" },
        });
      }
    });
  }

  async countActiveSessions(): Promise<number> {
    const [r] = await this.d.db.asSystem((tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(meetings)
        .where(inArray(meetings.status, ["joining", "in_progress"])),
    );
    return r?.n ?? 0;
  }
}
