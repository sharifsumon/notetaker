import {
  availabilityFromStatus,
  CANCELLABLE_STATUSES,
  canTransition,
  describeError,
  detectMeetingUrl,
  InvalidTransitionError,
  type ArtifactStatus,
  type MeetingDetail,
  type MeetingListQuery,
  type MeetingListResponse,
  type MeetingRow,
  type MeetingStatus,
  type Platform,
  type RecordingStatus,
  type TranscriptStatus,
} from "@notetaker/shared";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  ilike,
  isNull,
  lt,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { AuditService } from "../audit/audit.service";
import type { Db, Tx } from "../db/client";
import {
  meetingParticipants,
  meetings,
  meetingStatusEvents,
  users,
  type Meeting,
} from "../db/schema";
import { hmacSha256Hex, type TokenCipher } from "../lib/crypto";
import { Errors } from "../lib/errors";
import type { JobService } from "../jobs/job.service";

export interface TransitionOpts {
  source: string;
  reasonCode?: string | null;
  metadata?: Record<string, unknown>;
  patch?: Partial<typeof meetings.$inferInsert>;
}

export interface MeetingServiceDeps {
  db: Db;
  jobs: JobService;
  audit: AuditService;
  cipher: TokenCipher;
  urlHashKey: string;
  botConfigured: () => boolean;
  botSupports: (p: Platform) => boolean;
  joinLeadMinutes: number;
  now?: () => Date;
}

const DEFAULT_DURATION_MS = 60 * 60_000;

/** Meeting end used for "has it ended?" decisions when the calendar has no end time. */
export function effectiveEnd(m: Pick<Meeting, "scheduledStartAt" | "scheduledEndAt">): Date {
  return m.scheduledEndAt ?? new Date(m.scheduledStartAt.getTime() + DEFAULT_DURATION_MS);
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export class MeetingService {
  private readonly now: () => Date;

  constructor(private readonly d: MeetingServiceDeps) {
    this.now = d.now ?? (() => new Date());
  }

  // ------------------------------------------------------------------ helpers
  encryptUrl(userId: string, url: string): string {
    return this.d.cipher.encrypt(url, `meeting-url:${userId}`);
  }

  decryptUrl(m: Pick<Meeting, "userId" | "encryptedMeetingUrl">): string | null {
    return m.encryptedMeetingUrl
      ? this.d.cipher.decrypt(m.encryptedMeetingUrl, `meeting-url:${m.userId}`)
      : null;
  }

  urlHash(normalizedUrl: string): string {
    return hmacSha256Hex(this.d.urlHashKey, normalizedUrl);
  }

  /**
   * The single place meeting status changes. Rejects invalid transitions (FR-07) and
   * persists status history in the same transaction.
   */
  async transition(
    tx: Tx,
    meeting: Meeting,
    to: MeetingStatus,
    opts: TransitionOpts,
  ): Promise<Meeting> {
    const from = meeting.status as MeetingStatus;
    if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
    const [updated] = await tx
      .update(meetings)
      .set({ ...opts.patch, status: to, updatedAt: this.now() })
      .where(and(eq(meetings.id, meeting.id), eq(meetings.status, from)))
      .returning();
    if (!updated) {
      // Concurrent change: status no longer `from`. Treat as invalid to stay safe.
      throw new InvalidTransitionError(from, to);
    }
    await tx.insert(meetingStatusEvents).values({
      userId: meeting.userId,
      meetingId: meeting.id,
      oldStatus: from,
      newStatus: to,
      source: opts.source,
      reasonCode: opts.reasonCode ?? null,
      safeMetadata: opts.metadata ?? null,
    });
    return updated;
  }

  async recordInitialStatus(tx: Tx, meeting: Meeting, source: string): Promise<void> {
    await tx.insert(meetingStatusEvents).values({
      userId: meeting.userId,
      meetingId: meeting.id,
      oldStatus: null,
      newStatus: meeting.status,
      source,
    });
  }

  /** Loads a meeting owned by the user (RLS + explicit filter). Missing or foreign → 404. */
  async getOwned(tx: Tx, userId: string, meetingId: string, forUpdate = false): Promise<Meeting> {
    const q = tx
      .select()
      .from(meetings)
      .where(
        and(eq(meetings.id, meetingId), eq(meetings.userId, userId), isNull(meetings.deletedAt)),
      );
    const [m] = forUpdate ? await q.for("update") : await q;
    if (!m) throw Errors.notFound("Meeting");
    return m;
  }

  // ------------------------------------------------------------------ listing
  private statusColumns() {
    // Fully qualified: drizzle may render a bare column name inside select subqueries.
    const MID = sql.raw(`"meetings"."id"`);
    return {
      recordingStatus: sql<RecordingStatus | null>`(select r.status from recordings r where r.meeting_id = ${MID})`,
      transcriptStatus: sql<TranscriptStatus | null>`(select t.status from transcripts t where t.meeting_id = ${MID} order by t.created_at desc limit 1)`,
      summaryStatus: sql<ArtifactStatus | null>`(select a.status from meeting_artifacts a where a.meeting_id = ${MID} and a.artifact_type = 'summary' order by a.version desc limit 1)`,
      minutesStatus: sql<ArtifactStatus | null>`(select a.status from meeting_artifacts a where a.meeting_id = ${MID} and a.artifact_type = 'minutes' order by a.version desc limit 1)`,
      durationSeconds: sql<
        number | null
      >`(select r.duration_seconds from recordings r where r.meeting_id = ${MID})`,
    };
  }

  private toRow(
    m: Meeting & {
      recordingStatus: RecordingStatus | null;
      transcriptStatus: TranscriptStatus | null;
      summaryStatus: ArtifactStatus | null;
      minutesStatus: ArtifactStatus | null;
      durationSeconds: number | null;
    },
  ): MeetingRow {
    const status = m.status as MeetingStatus;
    const ended = effectiveEnd(m).getTime() <= this.now().getTime();
    return {
      id: m.id,
      title: m.title,
      platform: m.platform,
      scheduledStartAt: m.scheduledStartAt.toISOString(),
      scheduledEndAt: m.scheduledEndAt?.toISOString() ?? null,
      durationSeconds:
        m.durationSeconds ??
        (m.actualStartAt && m.actualEndAt
          ? Math.round((m.actualEndAt.getTime() - m.actualStartAt.getTime()) / 1000)
          : null),
      status,
      failureCode: m.failureCode,
      registrationSource: m.registrationSource,
      recording: availabilityFromStatus(m.recordingStatus),
      transcript: availabilityFromStatus(m.transcriptStatus),
      summary: availabilityFromStatus(m.summaryStatus),
      minutes: availabilityFromStatus(m.minutesStatus),
      canRegister:
        (status === "scheduled" || status === "cancelled" || status === "failed") &&
        !ended &&
        this.d.botConfigured() &&
        this.d.botSupports(m.platform),
      canCancel: CANCELLABLE_STATUSES.includes(status),
    };
  }

  async list(userId: string, q: MeetingListQuery): Promise<MeetingListResponse> {
    return this.d.db.asUser(userId, async (tx) => {
      const now = this.now();
      const conds: SQL[] = [eq(meetings.userId, userId), isNull(meetings.deletedAt)];
      if (q.from) conds.push(gte(meetings.scheduledStartAt, new Date(q.from)));
      if (q.to) conds.push(lt(meetings.scheduledStartAt, new Date(q.to)));
      if (q.platform) conds.push(eq(meetings.platform, q.platform));
      if (q.status) conds.push(eq(meetings.status, q.status));
      if (q.q) conds.push(ilike(meetings.title, `%${escapeLike(q.q)}%`));
      if (q.view === "upcoming") {
        // Not yet ended, and not already finished/being processed (those belong under "past").
        conds.push(
          notInArray(meetings.status, [
            "completed",
            "failed",
            "recording_processing",
            "deletion_pending",
          ]),
        );
        conds.push(
          or(
            gte(meetings.scheduledEndAt, now),
            and(
              isNull(meetings.scheduledEndAt),
              gte(meetings.scheduledStartAt, new Date(now.getTime() - DEFAULT_DURATION_MS)),
            ),
          )!,
        );
      } else if (q.view === "past") {
        conds.push(lt(meetings.scheduledStartAt, now));
      }
      const where = and(...conds);
      const order =
        q.view === "upcoming"
          ? [asc(meetings.scheduledStartAt), asc(meetings.id)]
          : [desc(meetings.scheduledStartAt), desc(meetings.id)];

      const rows = await tx
        .select({ ...getTableColumns(meetings), ...this.statusColumns() })
        .from(meetings)
        .where(where)
        .orderBy(...order)
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize);
      const [count] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(meetings)
        .where(where);
      const [stats] = await tx
        .select({
          total: sql<number>`count(*)::int`,
          completed: sql<number>`count(*) filter (where ${meetings.status} = 'completed')::int`,
          failed: sql<number>`count(*) filter (where ${meetings.status} = 'failed')::int`,
          processing: sql<number>`count(*) filter (where ${meetings.status} in ('joining','in_progress','recording_processing')
            or exists (select 1 from transcripts t where t.meeting_id = "meetings"."id" and t.status in ('pending','processing'))
            or exists (select 1 from meeting_artifacts a where a.meeting_id = "meetings"."id" and a.status in ('pending','processing')))::int`,
        })
        .from(meetings)
        .where(and(eq(meetings.userId, userId), isNull(meetings.deletedAt)));
      return {
        items: rows.map((r) => this.toRow(r)),
        page: q.page,
        pageSize: q.pageSize,
        total: count?.n ?? 0,
        stats: stats ?? { total: 0, completed: 0, processing: 0, failed: 0 },
      };
    });
  }

  async detail(userId: string, meetingId: string): Promise<MeetingDetail> {
    return this.d.db.asUser(userId, async (tx) => {
      const [m] = await tx
        .select({ ...getTableColumns(meetings), ...this.statusColumns() })
        .from(meetings)
        .where(
          and(eq(meetings.id, meetingId), eq(meetings.userId, userId), isNull(meetings.deletedAt)),
        );
      if (!m) throw Errors.notFound("Meeting");
      const participants = await tx
        .select({
          displayName: meetingParticipants.displayName,
          source: meetingParticipants.source,
        })
        .from(meetingParticipants)
        .where(eq(meetingParticipants.meetingId, meetingId))
        .orderBy(meetingParticipants.source, meetingParticipants.displayName)
        .limit(200);
      const history = await tx
        .select()
        .from(meetingStatusEvents)
        .where(eq(meetingStatusEvents.meetingId, meetingId))
        .orderBy(asc(meetingStatusEvents.occurredAt))
        .limit(100);
      return {
        ...this.toRow(m),
        actualStartAt: m.actualStartAt?.toISOString() ?? null,
        actualEndAt: m.actualEndAt?.toISOString() ?? null,
        timezoneAtCreation: m.timezoneAtCreation,
        failureMessage: describeError(m.failureCode),
        substatus: m.substatus,
        participants,
        statusHistory: history.map((h) => ({
          from: (h.oldStatus as MeetingStatus | null) ?? null,
          to: h.newStatus as MeetingStatus,
          source: h.source,
          reasonCode: h.reasonCode,
          occurredAt: h.occurredAt.toISOString(),
        })),
        fromCalendar: m.calendarConnectionId !== null,
      };
    });
  }

  // ------------------------------------------------------------------ registration
  /**
   * Queues a meeting for recording. Shared by manual and auto registration.
   * Idempotent: an already-registered meeting is returned unchanged (FR-03).
   */
  async registerInTx(
    tx: Tx,
    meeting: Meeting,
    opts: { source: "manual" | "auto"; actor: string; correlationId?: string },
  ): Promise<Meeting> {
    const status = meeting.status as MeetingStatus;
    if (["queued", "joining", "in_progress", "recording_processing", "completed"].includes(status))
      return meeting;
    if (!this.d.botConfigured()) throw Errors.notConfigured("Meeting recording provider");
    if (!this.d.botSupports(meeting.platform)) {
      throw Errors.unprocessable(
        "unsupported_platform",
        "This meeting platform is not supported by the recording provider",
      );
    }
    if (effectiveEnd(meeting).getTime() <= this.now().getTime()) {
      throw Errors.unprocessable(
        "meeting_ended",
        "This meeting has already ended and cannot be recorded",
      );
    }
    if (status !== "scheduled" && status !== "cancelled" && status !== "failed") {
      throw Errors.conflict(
        "invalid_state",
        `A meeting in status "${status}" cannot be registered`,
      );
    }
    const now = this.now();
    const updated = await this.transition(tx, meeting, "queued", {
      source: opts.source === "auto" ? "auto_registration" : "user",
      patch: {
        registrationSource: opts.source,
        registeredAt: now,
        registeredBy: opts.actor,
        failureCode: null,
        substatus: null,
        providerSessionId: null,
      },
    });
    const joinAt = new Date(meeting.scheduledStartAt.getTime() - this.d.joinLeadMinutes * 60_000);
    await this.d.jobs.enqueue(tx, {
      type: "bot_schedule",
      idempotencyKey: `bot_schedule:${meeting.id}:${now.getTime()}`,
      entityId: meeting.id,
      userId: meeting.userId,
      runAt: joinAt > now ? joinAt : now,
    });
    await this.d.audit.record(tx, {
      actorType: opts.source === "auto" ? "system" : "user",
      actorId: opts.source === "auto" ? null : opts.actor,
      action: "meeting.registered",
      targetType: "meeting",
      targetId: meeting.id,
      correlationId: opts.correlationId,
      metadata: { source: opts.source, platform: meeting.platform },
    });
    return updated;
  }

  private async assertConsent(tx: Tx, userId: string): Promise<{ timezone: string }> {
    const [u] = await tx.select().from(users).where(eq(users.id, userId));
    if (!u) throw Errors.unauthenticated();
    if (!u.recordingNoticeAcknowledgedAt) {
      throw Errors.conflict(
        "recording_notice_required",
        "Please review and acknowledge the recording notice in Settings before registering meetings",
      );
    }
    return { timezone: u.timezone };
  }

  async registerExisting(
    userId: string,
    meetingId: string,
    correlationId?: string,
  ): Promise<MeetingDetail> {
    await this.d.db.asUser(userId, async (tx) => {
      await this.assertConsent(tx, userId);
      const m = await this.getOwned(tx, userId, meetingId, true);
      await this.registerInTx(tx, m, { source: "manual", actor: userId, correlationId });
    });
    return this.detail(userId, meetingId);
  }

  async registerAdhoc(
    userId: string,
    body: { title: string; meetingUrl: string; startAt: string; endAt?: string },
    correlationId?: string,
  ): Promise<MeetingDetail> {
    const detected = detectMeetingUrl(body.meetingUrl);
    if (!detected) {
      throw Errors.unprocessable(
        "unsupported_meeting_url",
        "Only Google Meet and Microsoft Teams meeting links are supported",
      );
    }
    const start = new Date(body.startAt);
    const end = body.endAt ? new Date(body.endAt) : null;
    if (end && end <= start) throw Errors.badRequest("endAt must be after startAt");
    const id = await this.d.db.asUser(userId, async (tx) => {
      const { timezone } = await this.assertConsent(tx, userId);
      const hash = this.urlHash(detected.normalizedUrl);
      const inserted = await tx
        .insert(meetings)
        .values({
          userId,
          title: body.title,
          platform: detected.platform,
          encryptedMeetingUrl: this.encryptUrl(userId, detected.normalizedUrl),
          meetingUrlHash: hash,
          scheduledStartAt: start,
          scheduledEndAt: end,
          timezoneAtCreation: timezone,
          status: "scheduled",
        })
        .onConflictDoNothing()
        .returning();
      let m = inserted[0];
      if (m) await this.recordInitialStatus(tx, m, "user");
      else {
        // Duplicate manual registration of the same link + start time (FR-03).
        [m] = await tx
          .select()
          .from(meetings)
          .where(
            and(
              eq(meetings.userId, userId),
              eq(meetings.meetingUrlHash, hash),
              eq(meetings.scheduledStartAt, start),
              isNull(meetings.calendarConnectionId),
              isNull(meetings.deletedAt),
            ),
          )
          .for("update");
        if (!m) throw Errors.conflict("duplicate_meeting", "This meeting is already registered");
      }
      await this.registerInTx(tx, m, { source: "manual", actor: userId, correlationId });
      return m.id;
    });
    return this.detail(userId, id);
  }

  async cancel(userId: string, meetingId: string, correlationId?: string): Promise<MeetingDetail> {
    await this.d.db.asUser(userId, async (tx) => {
      const m = await this.getOwned(tx, userId, meetingId, true);
      if (m.status === "cancelled") return;
      if (!CANCELLABLE_STATUSES.includes(m.status as MeetingStatus)) {
        throw Errors.conflict(
          "not_cancellable",
          "Recording can only be cancelled before the bot is in the meeting",
        );
      }
      await this.cancelInTx(tx, m, "user", correlationId, userId);
    });
    return this.detail(userId, meetingId);
  }

  async cancelInTx(
    tx: Tx,
    m: Meeting,
    source: string,
    correlationId?: string,
    actorId?: string,
  ): Promise<void> {
    await this.transition(tx, m, "cancelled", { source, patch: { substatus: null } });
    await this.d.jobs.cancelPending(tx, "bot_schedule", m.id);
    if (m.providerSessionId) {
      await this.d.jobs.enqueue(tx, {
        type: "bot_cancel",
        idempotencyKey: `bot_cancel:${m.id}:${m.providerSessionId}`,
        entityId: m.id,
        userId: m.userId,
        payload: { sessionId: m.providerSessionId },
      });
    }
    await this.d.audit.record(tx, {
      actorType: actorId ? "user" : "system",
      actorId: actorId ?? null,
      action: "meeting.recording_cancelled",
      targetType: "meeting",
      targetId: m.id,
      correlationId,
      metadata: { source },
    });
  }

  /** Asynchronous deletion (FR-14): visible `deletion_pending` status, worker removes data. */
  async requestDeletion(userId: string, meetingId: string, correlationId?: string): Promise<void> {
    await this.d.db.asUser(userId, async (tx) => {
      const m = await this.getOwned(tx, userId, meetingId, true);
      if (m.status !== "deletion_pending") {
        await this.transition(tx, m, "deletion_pending", { source: "user" });
      }
      await this.d.jobs.enqueue(tx, {
        type: "meeting_delete",
        idempotencyKey: `meeting_delete:${m.id}`,
        entityId: m.id,
        userId,
        payload: { reason: "user_request" },
      });
      await this.d.audit.record(tx, {
        actorType: "user",
        actorId: userId,
        action: "meeting.deletion_requested",
        targetType: "meeting",
        targetId: m.id,
        correlationId,
      });
    });
  }
}
