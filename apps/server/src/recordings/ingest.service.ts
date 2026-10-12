import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, eq } from "drizzle-orm";
import type { AuditService } from "../audit/audit.service";
import type { MeetingBotProvider } from "../bot/types";
import type { Db } from "../db/client";
import { meetings, recordings, type Meeting } from "../db/schema";
import { PermanentJobError, ProviderError } from "../lib/errors";
import type { Logger } from "../lib/logger";
import type { JobService } from "../jobs/job.service";
import type { MeetingService } from "../meetings/meeting.service";
import { recordingKey, type StorageAdapter } from "../storage/types";
import type { MediaTools } from "./media";

export interface IngestDeps {
  db: Db;
  provider: MeetingBotProvider | null;
  storage: StorageAdapter;
  media: MediaTools;
  meetings: MeetingService;
  jobs: JobService;
  audit: AuditService;
  logger: Logger;
  maxBytes: number;
  maxDurationSeconds: number;
}

const INGEST_FAILURES = new Set([
  "recording_unavailable",
  "recording_invalid",
  "storage_error",
  "recording_too_large",
]);

class SizeLimit extends Transform {
  private seen = 0;
  readonly hash = createHash("sha256");
  constructor(private readonly max: number) {
    super();
  }
  override _transform(
    chunk: Buffer,
    _enc: BufferEncoding,
    cb: (err?: Error | null, data?: Buffer) => void,
  ) {
    this.seen += chunk.length;
    if (this.seen > this.max)
      return cb(new PermanentJobError("recording_too_large", "Recording exceeds size limit"));
    this.hash.update(chunk);
    cb(null, chunk);
  }
}

/**
 * Recording ingestion (FR-05): transfers the provider's recording into private storage,
 * validates type/size/duration, normalizes audio, records a checksum, then marks the
 * meeting `completed` and queues transcription. Idempotent and safe to retry.
 */
export class RecordingIngestService {
  constructor(private readonly d: IngestDeps) {}

  async ingest(meetingId: string): Promise<void> {
    const provider = this.d.provider;
    if (!provider)
      throw new PermanentJobError("provider_unavailable", "No meeting bot provider configured");

    const m = await this.d.db.asSystem(async (tx) => {
      let [row] = await tx.select().from(meetings).where(eq(meetings.id, meetingId)).for("update");
      if (!row || row.deletedAt || row.status === "deletion_pending") return null;
      if (row.status === "completed") return null; // already ingested
      if (
        row.status === "failed" &&
        row.providerSessionId &&
        INGEST_FAILURES.has(row.failureCode ?? "")
      ) {
        // Operator retry of a failed ingestion.
        row = await this.d.meetings.transition(tx, row, "recording_processing", {
          source: "retry",
          patch: { failureCode: null },
        });
      }
      if (row.status !== "recording_processing") return null;
      await tx
        .insert(recordings)
        .values({
          userId: row.userId,
          meetingId: row.id,
          storageProvider: this.d.storage.name,
          status: "processing",
        })
        .onConflictDoUpdate({
          target: recordings.meetingId,
          set: { status: "processing", errorCode: null, updatedAt: new Date() },
        });
      return row;
    });
    if (!m || !m.providerSessionId) return;

    const asset = await provider.getRecording(m.providerSessionId);
    if (asset.status === "processing") {
      throw new ProviderError(
        "recording_not_ready",
        "Provider is still processing the recording",
        true,
      );
    }
    if (asset.status === "unavailable") {
      await this.fail(m, "recording_unavailable");
      return;
    }

    const work = await mkdtemp(path.join(tmpdir(), "notetaker-ingest-"));
    try {
      const raw = path.join(work, "source.bin");
      const limiter = new SizeLimit(this.d.maxBytes);
      await pipeline(await asset.open(), limiter, createWriteStream(raw, { mode: 0o600 }));
      const sourceChecksum = limiter.hash.digest("hex");

      const probe = await this.d.media.probe(raw);
      if (!probe.hasAudio)
        throw new PermanentJobError("recording_invalid", "Recording has no audio stream");
      if (probe.durationSeconds !== null && probe.durationSeconds > this.d.maxDurationSeconds) {
        throw new PermanentJobError("recording_too_large", "Recording exceeds duration limit");
      }

      const normalized = path.join(work, "audio.m4a");
      try {
        await this.d.media.normalizeToM4a(raw, normalized, this.d.maxDurationSeconds);
      } catch {
        throw new PermanentJobError("recording_invalid", "Audio could not be decoded");
      }
      const outProbe = await this.d.media.probe(normalized);
      if (!outProbe.hasAudio)
        throw new PermanentJobError("recording_invalid", "Normalized audio invalid");
      const size = (await stat(normalized)).size;
      const checksum = await sha256File(normalized);

      const key = recordingKey(m.userId, m.id, randomUUID(), "m4a");
      try {
        await this.d.storage.putFile(key, normalized, "audio/mp4");
      } catch (err) {
        throw new ProviderError(
          "storage_error",
          `Storage write failed: ${(err as Error).name}`,
          true,
        );
      }

      await this.d.db.asSystem(async (tx) => {
        const [current] = await tx
          .select()
          .from(meetings)
          .where(eq(meetings.id, m.id))
          .for("update");
        const [existing] = await tx.select().from(recordings).where(eq(recordings.meetingId, m.id));
        if (!current || current.status !== "recording_processing") {
          // Deleted or changed concurrently: do not leave an orphaned object behind.
          await this.d.storage.delete(key).catch(() => undefined);
          return;
        }
        if (existing?.storageKey && existing.storageKey !== key) {
          await this.d.storage.delete(existing.storageKey).catch(() => undefined);
        }
        const [rec] = await tx
          .update(recordings)
          .set({
            storageProvider: this.d.storage.name,
            storageKey: key,
            mimeType: "audio/mp4",
            fileSizeBytes: size,
            durationSeconds:
              outProbe.durationSeconds !== null ? Math.round(outProbe.durationSeconds) : null,
            checksumSha256: checksum,
            status: "ready",
            errorCode: null,
            providerAssetId: asset.providerAssetId,
            recordedAt: asset.recordedAt ?? current.actualStartAt,
            storedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(recordings.meetingId, m.id))
          .returning();
        await this.d.meetings.transition(tx, current, "completed", {
          source: "ingestion",
          metadata: { sourceChecksum: sourceChecksum.slice(0, 16), sizeBytes: size },
        });
        await this.d.jobs.enqueue(tx, {
          type: "transcribe",
          idempotencyKey: `transcribe:${rec!.id}`,
          entityId: rec!.id,
          userId: m.userId,
        });
        await this.d.audit.record(tx, {
          actorType: "system",
          action: "recording.stored",
          targetType: "meeting",
          targetId: m.id,
          metadata: { sizeBytes: size, durationSeconds: rec!.durationSeconds },
        });
      });
    } catch (err) {
      if (err instanceof PermanentJobError) {
        await this.fail(m, err.code);
        return;
      }
      throw err;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  /** Final failure: recording + meeting marked failed with a safe code (retryable by operators). */
  async fail(m: Pick<Meeting, "id">, code: string): Promise<void> {
    await this.d.db.asSystem(async (tx) => {
      const [current] = await tx.select().from(meetings).where(eq(meetings.id, m.id)).for("update");
      await tx
        .update(recordings)
        .set({ status: "failed", errorCode: code, updatedAt: new Date() })
        .where(and(eq(recordings.meetingId, m.id)));
      if (current && current.status === "recording_processing") {
        await this.d.meetings.transition(tx, current, "failed", {
          source: "ingestion",
          reasonCode: code,
          patch: { failureCode: code },
        });
      }
    });
  }
}

async function sha256File(file: string): Promise<string> {
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}
