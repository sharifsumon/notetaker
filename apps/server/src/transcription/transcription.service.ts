import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { and, desc, eq } from "drizzle-orm";
import type { ArtifactService } from "../ai/artifact.service";
import { mockScenarioFromTitle } from "../bot/mock-provider";
import type { Db } from "../db/client";
import { meetings, recordings, transcripts } from "../db/schema";
import { PermanentJobError } from "../lib/errors";
import type { StorageAdapter } from "../storage/types";
import { countWords, type TranscriptionProvider } from "./types";

export interface TranscriptionServiceDeps {
  db: Db;
  stt: TranscriptionProvider | null;
  storage: StorageAdapter;
  artifacts: ArtifactService;
  minWords: number;
  language?: string;
  autoSummary: boolean;
  autoMinutes: boolean;
}

/** Transcription pipeline (FR-09). Transcript status is tracked independently of the meeting. */
export class TranscriptionService {
  constructor(private readonly d: TranscriptionServiceDeps) {}

  async transcribe(recordingId: string): Promise<void> {
    const stt = this.d.stt;
    if (!stt) throw new PermanentJobError("transcription_failed", "No speech-to-text provider configured");

    const ctx = await this.d.db.asSystem(async (tx) => {
      const [rec] = await tx.select().from(recordings).where(eq(recordings.id, recordingId));
      if (!rec || rec.status !== "ready" || !rec.storageKey) return null;
      const [m] = await tx.select().from(meetings).where(eq(meetings.id, rec.meetingId));
      if (!m || m.deletedAt || m.status === "deletion_pending") return null;
      const [existing] = await tx.select().from(transcripts).where(eq(transcripts.recordingId, rec.id));
      if (existing?.status === "completed") return null; // idempotent
      await tx
        .insert(transcripts)
        .values({ userId: rec.userId, meetingId: rec.meetingId, recordingId: rec.id, status: "processing", provider: stt.name, model: stt.model })
        .onConflictDoUpdate({
          target: transcripts.recordingId,
          set: { status: "processing", errorCode: null, provider: stt.name, model: stt.model, updatedAt: new Date() },
        });
      return { rec, meeting: m };
    });
    if (!ctx) return;

    const work = await mkdtemp(path.join(tmpdir(), "notetaker-stt-"));
    try {
      const file = path.join(work, "audio.m4a");
      await pipeline(await this.d.storage.openRead(ctx.rec.storageKey!), createWriteStream(file, { mode: 0o600 }));
      const result = await stt.transcribe({
        filePath: file,
        mimeType: ctx.rec.mimeType ?? "audio/mp4",
        durationSeconds: ctx.rec.durationSeconds,
        language: this.d.language,
        mockScenario: stt.isMock ? mockScenarioFromTitle(ctx.meeting.title) : null,
      });
      const segments = result.segments.filter((s) => s.text.trim().length > 0);
      if (segments.length === 0) throw new PermanentJobError("transcript_empty", "No speech detected");
      const words = countWords(segments);
      const quality = words < this.d.minWords ? "insufficient" : "ok";

      await this.d.db.asSystem(async (tx) => {
        await tx
          .update(transcripts)
          .set({
            status: "completed",
            language: result.language,
            text: segments.map((s) => s.text).join("\n"),
            segments,
            wordCount: words,
            quality,
            isMock: stt.isMock,
            rawOutput: (result.raw as Record<string, unknown> | undefined) ?? null,
            errorCode: null,
            updatedAt: new Date(),
          })
          .where(eq(transcripts.recordingId, recordingId));
      });
      if (this.d.autoSummary) await this.d.artifacts.requestSystem(ctx.meeting.id, "summary");
      if (this.d.autoMinutes) await this.d.artifacts.requestSystem(ctx.meeting.id, "minutes");
    } catch (err) {
      if (err instanceof PermanentJobError) {
        await this.markFailed(recordingId, err.code);
        return;
      }
      throw err;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  async markFailed(recordingId: string, code: string): Promise<void> {
    await this.d.db.asSystem((tx) =>
      tx.update(transcripts).set({ status: "failed", errorCode: code, updatedAt: new Date() }).where(eq(transcripts.recordingId, recordingId)),
    );
  }

  static async latestForMeeting(tx: Parameters<Parameters<Db["asSystem"]>[0]>[0], meetingId: string) {
    const [t] = await tx
      .select()
      .from(transcripts)
      .where(and(eq(transcripts.meetingId, meetingId)))
      .orderBy(desc(transcripts.createdAt))
      .limit(1);
    return t ?? null;
  }
}
