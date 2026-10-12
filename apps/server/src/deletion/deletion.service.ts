import { and, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import type { AuditService } from "../audit/audit.service";
import type { MeetingBotProvider } from "../bot/types";
import type { Db } from "../db/client";
import {
  jobs,
  meetingArtifacts,
  meetingParticipants,
  meetings,
  recordings,
  transcripts,
} from "../db/schema";
import type { Logger } from "../lib/logger";
import type { JobService } from "../jobs/job.service";
import type { MeetingService } from "../meetings/meeting.service";
import type { StorageAdapter } from "../storage/types";

export interface DeletionDeps {
  db: Db;
  storage: StorageAdapter;
  provider: MeetingBotProvider | null;
  meetings: MeetingService;
  jobs: JobService;
  audit: AuditService;
  logger: Logger;
  retentionDays: number;
}

/**
 * Deletion and retention (FR-14). Removes stored audio and derived content; keeps a
 * content-free tombstone row so calendar sync never resurrects a deleted meeting.
 * Audit entries contain ids and counts only, never deleted content.
 */
export class DeletionService {
  constructor(private readonly d: DeletionDeps) {}

  async deleteMeeting(meetingId: string, reason: string): Promise<void> {
    const ctx = await this.d.db.asSystem(async (tx) => {
      const [m] = await tx.select().from(meetings).where(eq(meetings.id, meetingId)).for("update");
      if (!m || m.deletedAt) return null;
      if (m.status !== "deletion_pending") {
        await this.d.meetings.transition(tx, m, "deletion_pending", { source: reason });
      }
      const [rec] = await tx.select().from(recordings).where(eq(recordings.meetingId, m.id));
      const artifactIds = (
        await tx
          .select({ id: meetingArtifacts.id })
          .from(meetingArtifacts)
          .where(eq(meetingArtifacts.meetingId, m.id))
      ).map((a) => a.id);
      // Stop all pending work for this meeting only.
      const entityIds = [m.id, ...(rec ? [rec.id] : []), ...artifactIds];
      await tx
        .update(jobs)
        .set({ status: "cancelled", updatedAt: new Date(), completedAt: new Date() })
        .where(
          and(
            inArray(jobs.status, ["pending", "queued"]),
            inArray(jobs.entityId, entityIds),
            inArray(jobs.type, [
              "bot_schedule",
              "recording_ingest",
              "transcribe",
              "generate_summary",
              "generate_minutes",
            ]),
          ),
        );
      return { m, storageKey: rec?.storageKey ?? null };
    });
    if (!ctx) return;
    const { m } = ctx;

    if (
      m.providerSessionId &&
      this.d.provider &&
      ["queued", "joining", "in_progress"].includes(m.status)
    ) {
      await this.d.provider.cancelSession(m.providerSessionId).catch((err: Error) => {
        this.d.logger.warn(
          { meetingId, err: err.message },
          "provider session cancel failed during deletion",
        );
      });
    }
    // Storage first: if this fails the job retries and DB rows still point at the object.
    if (ctx.storageKey) await this.d.storage.delete(ctx.storageKey);

    await this.d.db.asSystem(async (tx) => {
      const counts = {
        artifacts: (
          await tx
            .delete(meetingArtifacts)
            .where(eq(meetingArtifacts.meetingId, m.id))
            .returning({ id: meetingArtifacts.id })
        ).length,
        transcripts: (
          await tx
            .delete(transcripts)
            .where(eq(transcripts.meetingId, m.id))
            .returning({ id: transcripts.id })
        ).length,
        recordings: (
          await tx
            .delete(recordings)
            .where(eq(recordings.meetingId, m.id))
            .returning({ id: recordings.id })
        ).length,
        participants: (
          await tx
            .delete(meetingParticipants)
            .where(eq(meetingParticipants.meetingId, m.id))
            .returning({ id: meetingParticipants.id })
        ).length,
      };
      await tx
        .update(meetings)
        .set({
          title: "[deleted]",
          encryptedMeetingUrl: null,
          meetingUrlHash: null,
          deletedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(meetings.id, m.id));
      await this.d.audit.record(tx, {
        actorType: reason === "retention" ? "system" : "user",
        actorId: reason === "retention" ? null : m.userId,
        action: "meeting.deleted",
        targetType: "meeting",
        targetId: m.id,
        metadata: { reason, ...counts },
      });
    });
  }

  /** Periodic retention: queues deletion of meetings whose recordings exceed the retention period. */
  async enqueueRetention(now = new Date()): Promise<number> {
    if (this.d.retentionDays <= 0) return 0;
    const cutoff = new Date(now.getTime() - this.d.retentionDays * 86_400_000);
    return this.d.db.asSystem(async (tx) => {
      const expired = await tx
        .select({ id: meetings.id, userId: meetings.userId })
        .from(meetings)
        .innerJoin(recordings, eq(recordings.meetingId, meetings.id))
        .where(
          and(
            isNull(meetings.deletedAt),
            isNotNull(recordings.storedAt),
            lt(recordings.storedAt, cutoff),
          ),
        )
        .limit(500);
      for (const e of expired) {
        await this.d.jobs.enqueue(tx, {
          type: "meeting_delete",
          idempotencyKey: `meeting_delete:${e.id}`,
          entityId: e.id,
          userId: e.userId,
          payload: { reason: "retention" },
        });
      }
      return expired.length;
    });
  }
}
