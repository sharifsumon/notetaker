import type { CalendarConnection, CalendarProvider, MeetingStatus } from "@notetaker/shared";
import { and, eq, inArray, isNull, gte, ne } from "drizzle-orm";
import type { AuditService } from "../audit/audit.service";
import { CALENDAR_SCOPES, ReauthRequiredError, type IdentityProvider, type OAuthClient } from "../auth/oauth";
import type { Db, Tx } from "../db/client";
import { calendarConnections, meetingParticipants, meetings, users, type CalendarConnectionRow, type Meeting } from "../db/schema";
import type { TokenCipher } from "../lib/crypto";
import { Errors, PermanentJobError, ProviderError } from "../lib/errors";
import type { Logger } from "../lib/logger";
import type { JobService } from "../jobs/job.service";
import type { MeetingService } from "../meetings/meeting.service";
import { CursorExpiredError, type CalendarApi, type NormalizedEvent } from "./types";

export const CALENDAR_TO_IDP: Record<CalendarProvider, IdentityProvider> = {
  google_calendar: "google",
  microsoft_calendar: "microsoft",
};

export interface CalendarServiceDeps {
  db: Db;
  cipher: TokenCipher;
  jobs: JobService;
  audit: AuditService;
  meetings: MeetingService;
  logger: Logger;
  oauth: Partial<Record<IdentityProvider, OAuthClient>>;
  apis: Partial<Record<CalendarProvider, CalendarApi>>;
  pastDays: number;
  futureDays: number;
  syncIntervalMinutes: number;
  now?: () => Date;
}

const ACTIVE_FOR_SYNC_UPDATE: MeetingStatus[] = ["scheduled", "queued", "cancelled", "unsupported"];

export class CalendarService {
  private readonly now: () => Date;

  constructor(private readonly d: CalendarServiceDeps) {
    this.now = d.now ?? (() => new Date());
  }

  isConfigured(provider: CalendarProvider): boolean {
    return !!this.d.oauth[CALENDAR_TO_IDP[provider]] && !!this.d.apis[provider];
  }

  private aad(userId: string, provider: string) {
    return `calendar:${userId}:${provider}`;
  }

  toDto(c: CalendarConnectionRow): CalendarConnection {
    return {
      id: c.id,
      provider: c.provider,
      status: c.status,
      accountEmail: c.accountEmail,
      scopes: c.scopes,
      lastSyncedAt: c.lastSyncedAt?.toISOString() ?? null,
      lastErrorCode: c.lastErrorCode,
      syncInProgress: c.syncInProgress,
    };
  }

  async list(userId: string): Promise<CalendarConnection[]> {
    const rows = await this.d.db.asUser(userId, (tx) =>
      tx
        .select()
        .from(calendarConnections)
        .where(and(eq(calendarConnections.userId, userId), ne(calendarConnections.status, "disconnected"))),
    );
    return rows.map((r) => this.toDto(r));
  }

  /** Stores tokens from a completed calendar consent and queues an initial sync. */
  async saveConnection(
    userId: string,
    provider: CalendarProvider,
    tokens: { accessToken: string; refreshToken: string | null; expiresAt: Date; scopes: string[] },
    account: { subject: string; email: string | null },
    correlationId?: string,
  ): Promise<CalendarConnection> {
    if (!tokens.refreshToken) {
      throw Errors.unprocessable("calendar_no_refresh_token", "The provider did not grant offline access. Please try again.");
    }
    const aad = this.aad(userId, provider);
    const row = await this.d.db.asUser(userId, async (tx) => {
      const values = {
        userId,
        provider,
        accountSubject: account.subject,
        accountEmail: account.email,
        encryptedRefreshToken: this.d.cipher.encrypt(tokens.refreshToken!, aad),
        encryptedAccessToken: this.d.cipher.encrypt(tokens.accessToken, aad),
        accessTokenExpiresAt: tokens.expiresAt,
        scopes: tokens.scopes.length > 0 ? tokens.scopes : CALENDAR_SCOPES[CALENDAR_TO_IDP[provider]],
        status: "active" as const,
        lastErrorCode: null,
        updatedAt: this.now(),
      };
      const [r] = await tx
        .insert(calendarConnections)
        .values(values)
        .onConflictDoUpdate({
          target: [calendarConnections.userId, calendarConnections.provider, calendarConnections.accountSubject],
          set: values,
        })
        .returning();
      await this.enqueueSync(tx, r!.id, userId, "connect");
      await this.d.audit.record(tx, {
        actorType: "user",
        actorId: userId,
        action: "calendar.connected",
        targetType: "calendar_connection",
        targetId: r!.id,
        correlationId,
        metadata: { provider },
      });
      return r!;
    });
    return this.toDto(row);
  }

  private async enqueueSync(tx: Tx, connectionId: string, userId: string, reason: string): Promise<void> {
    const bucket = Math.floor(this.now().getTime() / 60_000);
    await this.d.jobs.enqueue(tx, {
      type: "calendar_sync",
      idempotencyKey: `calendar_sync:${connectionId}:${reason}:${bucket}`,
      entityId: connectionId,
      userId,
    });
  }

  async requestSync(userId: string, connectionId: string): Promise<void> {
    await this.d.db.asUser(userId, async (tx) => {
      const [c] = await tx
        .select()
        .from(calendarConnections)
        .where(and(eq(calendarConnections.id, connectionId), eq(calendarConnections.userId, userId)));
      if (!c || c.status === "disconnected") throw Errors.notFound("Calendar connection");
      if (c.status === "reconnect_required") {
        throw Errors.conflict("calendar_reconnect_required", "Calendar access was revoked or expired. Please reconnect.");
      }
      await this.enqueueSync(tx, c.id, userId, "manual");
    });
  }

  /** Disconnect: revoke tokens (best effort), delete them, and remove unregistered future meetings. */
  async disconnect(userId: string, connectionId: string, correlationId?: string): Promise<void> {
    const conn = await this.d.db.asUser(userId, async (tx) => {
      const [c] = await tx
        .select()
        .from(calendarConnections)
        .where(and(eq(calendarConnections.id, connectionId), eq(calendarConnections.userId, userId)));
      if (!c || c.status === "disconnected") throw Errors.notFound("Calendar connection");
      await tx
        .update(calendarConnections)
        .set({
          status: "disconnected",
          encryptedAccessToken: null,
          encryptedRefreshToken: null,
          syncState: null,
          updatedAt: this.now(),
        })
        .where(eq(calendarConnections.id, c.id));
      // Unregistered synced meetings would go stale; recorded/registered ones are kept.
      await tx
        .update(meetings)
        .set({ deletedAt: this.now(), encryptedMeetingUrl: null, updatedAt: this.now() })
        .where(
          and(
            eq(meetings.calendarConnectionId, c.id),
            eq(meetings.status, "scheduled"),
            isNull(meetings.deletedAt),
            gte(meetings.scheduledStartAt, this.now()),
          ),
        );
      await this.d.audit.record(tx, {
        actorType: "user",
        actorId: userId,
        action: "calendar.disconnected",
        targetType: "calendar_connection",
        targetId: c.id,
        correlationId,
        metadata: { provider: c.provider },
      });
      return c;
    });
    const client = this.d.oauth[CALENDAR_TO_IDP[conn.provider]];
    if (client && conn.encryptedRefreshToken) {
      try {
        await client.revoke(this.d.cipher.decrypt(conn.encryptedRefreshToken, this.aad(userId, conn.provider)));
      } catch {
        this.d.logger.warn({ connectionId }, "token revocation failed (tokens already deleted locally)");
      }
    }
  }

  /** Periodic: queue syncs for all active connections (idempotent per interval bucket). */
  async enqueueDueSyncs(): Promise<number> {
    return this.d.db.asSystem(async (tx) => {
      const conns = await tx
        .select({ id: calendarConnections.id, userId: calendarConnections.userId })
        .from(calendarConnections)
        .where(inArray(calendarConnections.status, ["active", "error"]));
      const bucket = Math.floor(this.now().getTime() / (this.d.syncIntervalMinutes * 60_000));
      for (const c of conns) {
        await this.d.jobs.enqueue(tx, {
          type: "calendar_sync",
          idempotencyKey: `calendar_sync:${c.id}:periodic:${bucket}`,
          entityId: c.id,
          userId: c.userId,
        });
      }
      return conns.length;
    });
  }

  // ------------------------------------------------------------------ sync
  private async accessToken(c: CalendarConnectionRow): Promise<string> {
    const aad = this.aad(c.userId, c.provider);
    if (c.encryptedAccessToken && c.accessTokenExpiresAt && c.accessTokenExpiresAt.getTime() - 60_000 > this.now().getTime()) {
      return this.d.cipher.decrypt(c.encryptedAccessToken, aad);
    }
    if (!c.encryptedRefreshToken) throw new ReauthRequiredError();
    const client = this.d.oauth[CALENDAR_TO_IDP[c.provider]];
    if (!client) throw new PermanentJobError("calendar_sync_failed", "OAuth client not configured");
    const refreshed = await client.refresh(
      this.d.cipher.decrypt(c.encryptedRefreshToken, aad),
      CALENDAR_SCOPES[CALENDAR_TO_IDP[c.provider]],
    );
    await this.d.db.asSystem((tx) =>
      tx
        .update(calendarConnections)
        .set({
          encryptedAccessToken: this.d.cipher.encrypt(refreshed.accessToken, aad),
          accessTokenExpiresAt: refreshed.expiresAt,
          // Providers may rotate refresh tokens.
          ...(refreshed.refreshToken ? { encryptedRefreshToken: this.d.cipher.encrypt(refreshed.refreshToken, aad) } : {}),
          updatedAt: this.now(),
        })
        .where(eq(calendarConnections.id, c.id)),
    );
    return refreshed.accessToken;
  }

  /** Job: incremental calendar sync with pagination, cursor recovery and revocation handling. */
  async sync(connectionId: string): Promise<{ upserted: number; cancelled: number }> {
    const [c] = await this.d.db.asSystem((tx) =>
      tx.select().from(calendarConnections).where(eq(calendarConnections.id, connectionId)),
    );
    if (!c || c.status === "disconnected" || c.status === "reconnect_required") return { upserted: 0, cancelled: 0 };
    const api = this.d.apis[c.provider];
    if (!api) throw new PermanentJobError("calendar_sync_failed", "Calendar API not configured");

    await this.d.db.asSystem((tx) =>
      tx.update(calendarConnections).set({ syncInProgress: true }).where(eq(calendarConnections.id, c.id)),
    );
    try {
      const now = this.now();
      const windowStart = new Date(now.getTime() - this.d.pastDays * 86_400_000);
      const windowEnd = new Date(now.getTime() + this.d.futureDays * 86_400_000);
      // A cursor is bound to the window it was created with; refresh it daily so new
      // far-future events enter the window.
      const state = c.syncState ?? {};
      const stale =
        !state.windowEnd || new Date(state.windowEnd).getTime() < windowEnd.getTime() - 86_400_000;
      let cursor = stale ? null : (state.cursor ?? null);
      const token = await this.accessToken(c);

      let result;
      try {
        result = await api.listChanges({ accessToken: token, cursor, windowStart, windowEnd });
      } catch (err) {
        if (!(err instanceof CursorExpiredError)) throw err;
        cursor = null;
        result = await api.listChanges({ accessToken: token, cursor: null, windowStart, windowEnd });
      }
      const fullSync = cursor === null;

      const [user] = await this.d.db.asSystem((tx) => tx.select().from(users).where(eq(users.id, c.userId)));
      let upserted = 0;
      let cancelled = 0;
      for (const ev of result.events) {
        const r = await this.applyEvent(c, ev, user ?? null);
        if (r === "upserted") upserted++;
        if (r === "cancelled") cancelled++;
      }

      await this.d.db.asSystem((tx) =>
        tx
          .update(calendarConnections)
          .set({
            syncState: {
              cursor: result.nextCursor ?? undefined,
              windowStart: (fullSync ? windowStart : new Date(state.windowStart ?? windowStart)).toISOString(),
              windowEnd: (fullSync ? windowEnd : new Date(state.windowEnd ?? windowEnd)).toISOString(),
            },
            status: "active",
            lastSyncedAt: this.now(),
            lastErrorCode: null,
            syncInProgress: false,
            updatedAt: this.now(),
          })
          .where(eq(calendarConnections.id, c.id)),
      );
      return { upserted, cancelled };
    } catch (err) {
      const reauth = err instanceof ReauthRequiredError;
      await this.d.db.asSystem((tx) =>
        tx
          .update(calendarConnections)
          .set({
            syncInProgress: false,
            status: reauth ? "reconnect_required" : "error",
            lastErrorCode: reauth ? "calendar_reconnect_required" : "calendar_sync_failed",
            updatedAt: this.now(),
          })
          .where(eq(calendarConnections.id, c.id)),
      );
      if (reauth) {
        await this.d.db.asSystem((tx) =>
          this.d.audit.record(tx, {
            actorType: "system",
            action: "calendar.reconnect_required",
            targetType: "calendar_connection",
            targetId: c.id,
          }),
        );
        return { upserted: 0, cancelled: 0 }; // not retryable; user must reconnect
      }
      if (err instanceof ProviderError) throw err;
      throw new ProviderError("calendar_sync_failed", (err as Error).message, true);
    }
  }

  /** Applies one normalized event to the meetings table. Exposed for tests. */
  async applyEvent(
    c: CalendarConnectionRow,
    ev: NormalizedEvent,
    user: { id: string; timezone: string; autoRegister: boolean | null; recordingNoticeAcknowledgedAt: Date | null } | null,
  ): Promise<"upserted" | "cancelled" | "skipped"> {
    return this.d.db.asSystem(async (tx) => {
      const [existing] = await tx
        .select()
        .from(meetings)
        .where(and(eq(meetings.calendarConnectionId, c.id), eq(meetings.providerEventId, ev.providerEventId)))
        .for("update");
      if (existing?.deletedAt) return "skipped"; // user deleted it; never resurrect

      if (ev.cancelled || !ev.meeting || ev.isAllDay || !ev.start) {
        if (!existing) return "skipped";
        const status = existing.status as MeetingStatus;
        if (status === "queued") {
          await this.d.meetings.cancelInTx(tx, existing, "calendar");
          return "cancelled";
        }
        if (status === "scheduled") {
          await this.d.meetings.transition(tx, existing, "cancelled", { source: "calendar" });
          return "cancelled";
        }
        return "skipped"; // meeting already happening/recorded: keep history
      }

      const end = ev.end && ev.end > ev.start ? ev.end : null;
      const encUrl = this.d.meetings.encryptUrl(c.userId, ev.meeting.normalizedUrl);
      let meeting: Meeting;
      if (!existing) {
        const [inserted] = await tx
          .insert(meetings)
          .values({
            userId: c.userId,
            calendarConnectionId: c.id,
            providerEventId: ev.providerEventId,
            providerEventVersion: ev.version,
            title: ev.title,
            platform: ev.meeting.platform,
            encryptedMeetingUrl: encUrl,
            meetingUrlHash: this.d.meetings.urlHash(ev.meeting.normalizedUrl),
            scheduledStartAt: ev.start,
            scheduledEndAt: end,
            timezoneAtCreation: user?.timezone ?? "UTC",
            status: "scheduled",
          })
          .onConflictDoNothing()
          .returning();
        if (!inserted) return "skipped";
        meeting = inserted;
        await this.d.meetings.recordInitialStatus(tx, meeting, "calendar");
      } else {
        if (existing.providerEventVersion === ev.version && ev.version !== null) {
          meeting = existing;
        } else {
          const status = existing.status as MeetingStatus;
          if (!ACTIVE_FOR_SYNC_UPDATE.includes(status)) return "skipped";
          const timeChanged =
            existing.scheduledStartAt.getTime() !== ev.start.getTime() ||
            this.d.meetings.decryptUrl(existing) !== ev.meeting.normalizedUrl;
          const [updated] = await tx
            .update(meetings)
            .set({
              title: ev.title,
              platform: ev.meeting.platform,
              encryptedMeetingUrl: encUrl,
              meetingUrlHash: this.d.meetings.urlHash(ev.meeting.normalizedUrl),
              scheduledStartAt: ev.start,
              scheduledEndAt: end,
              providerEventVersion: ev.version,
              updatedAt: this.now(),
            })
            .where(eq(meetings.id, existing.id))
            .returning();
          meeting = updated!;
          if (status === "cancelled" && existing.registrationSource === null) {
            // Event re-confirmed after a calendar cancellation.
            meeting = await this.d.meetings.transition(tx, meeting, "scheduled", { source: "calendar" });
          }
          if (status === "queued" && timeChanged) {
            // Rescheduled: cancel any created session and schedule a fresh one.
            await this.d.meetings.cancelInTx(tx, meeting, "calendar_reschedule");
            meeting = (await tx.select().from(meetings).where(eq(meetings.id, meeting.id)))[0]!;
            await this.d.meetings.registerInTx(tx, meeting, {
              source: (existing.registrationSource ?? "auto") as "manual" | "auto",
              actor: existing.registeredBy ?? "system:calendar",
            });
          }
        }
      }

      for (const a of ev.attendees) {
        await tx
          .insert(meetingParticipants)
          .values({
            userId: c.userId,
            meetingId: meeting.id,
            displayName: a.name.slice(0, 200),
            email: null, // data minimization: names are sufficient for minutes
            source: "calendar",
            sourceKey: a.key.slice(0, 200),
            participantType: a.type,
          })
          .onConflictDoNothing();
      }

      // Auto-registration only with an explicit opt-in and acknowledged recording notice.
      if (
        meeting.status === "scheduled" &&
        user?.autoRegister === true &&
        user.recordingNoticeAcknowledgedAt &&
        meeting.scheduledStartAt.getTime() > this.now().getTime()
      ) {
        try {
          await tx.transaction(async (sp) => {
            await this.d.meetings.registerInTx(sp, meeting, { source: "auto", actor: "system:auto" });
          });
        } catch (err) {
          this.d.logger.info({ meetingId: meeting.id, code: (err as { code?: string }).code }, "auto-registration skipped");
        }
      }
      return "upserted";
    });
  }
}
