import {
  describeError,
  MinutesContentSchema,
  renderMinutesText,
  renderSummaryText,
  SummaryContentSchema,
  type ArtifactType,
  type MeetingDetails,
  type MinutesArtifact,
  type MinutesContent,
  type SummaryArtifact,
  type SummaryContent,
} from "@notetaker/shared";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { AuditService } from "../audit/audit.service";
import type { Db, Tx } from "../db/client";
import {
  meetingArtifacts,
  meetingParticipants,
  meetings,
  transcripts,
  type ArtifactRow,
} from "../db/schema";
import { Errors, PermanentJobError, ProviderError } from "../lib/errors";
import type { JobService } from "../jobs/job.service";
import type { Metrics } from "../metrics";
import type { ArtifactGenerator } from "./generator";
import type { LlmProvider } from "./types";

export interface ArtifactServiceDeps {
  db: Db;
  jobs: JobService;
  audit: AuditService;
  metrics: Metrics;
  llm: LlmProvider | null;
  generator: ArtifactGenerator | null;
}

const INSUFFICIENT_NOTE =
  "A reliable result could not be generated because the transcript is too short or unclear.";

/**
 * Summary and Minutes generation (FR-10, FR-11). Each generation creates a new version row;
 * content is schema-validated and stored with provider/model/prompt-version metadata.
 */
export class ArtifactService {
  constructor(private readonly d: ArtifactServiceDeps) {}

  private async latest(tx: Tx, meetingId: string, type: ArtifactType): Promise<ArtifactRow | null> {
    const [a] = await tx
      .select()
      .from(meetingArtifacts)
      .where(
        and(eq(meetingArtifacts.meetingId, meetingId), eq(meetingArtifacts.artifactType, type)),
      )
      .orderBy(desc(meetingArtifacts.version))
      .limit(1);
    return a ?? null;
  }

  private async latestCompleted(
    tx: Tx,
    meetingId: string,
    type: ArtifactType,
  ): Promise<ArtifactRow | null> {
    const [a] = await tx
      .select()
      .from(meetingArtifacts)
      .where(
        and(
          eq(meetingArtifacts.meetingId, meetingId),
          eq(meetingArtifacts.artifactType, type),
          eq(meetingArtifacts.status, "completed"),
        ),
      )
      .orderBy(desc(meetingArtifacts.version))
      .limit(1);
    return a ?? null;
  }

  /**
   * Creates (or returns the in-flight/existing) generation. Idempotent: concurrent or
   * repeated requests do not create duplicate jobs (FR-13).
   */
  private async requestInTx(
    tx: Tx,
    meetingId: string,
    userId: string,
    type: ArtifactType,
    createdBy: "system" | "user",
    regenerate: boolean,
  ): Promise<{ artifact: ArtifactRow; created: boolean }> {
    const transcript = await this.latestTranscript(tx, meetingId);
    if (!transcript || transcript.status === "pending" || transcript.status === "processing") {
      throw Errors.conflict("transcript_not_ready", "The transcript is not ready yet");
    }
    if (transcript.status === "failed") {
      throw Errors.unprocessable(
        "transcript_unavailable",
        describeError(transcript.errorCode) ?? "Transcript unavailable",
      );
    }
    if (!this.d.llm) throw Errors.notConfigured("AI generation provider");

    const current = await this.latest(tx, meetingId, type);
    if (current && (current.status === "pending" || current.status === "processing")) {
      return { artifact: current, created: false };
    }
    if (current && current.status === "completed" && !regenerate)
      return { artifact: current, created: false };

    const version = (current?.version ?? 0) + 1;
    const inserted = await tx
      .insert(meetingArtifacts)
      .values({
        userId,
        meetingId,
        transcriptId: transcript.id,
        artifactType: type,
        version,
        status: "pending",
        createdBy,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted[0]) {
      const again = await this.latest(tx, meetingId, type);
      return { artifact: again!, created: false };
    }
    await this.d.jobs.enqueue(tx, {
      type: type === "summary" ? "generate_summary" : "generate_minutes",
      idempotencyKey: `generate_${type}:${inserted[0].id}`,
      entityId: inserted[0].id,
      userId,
    });
    return { artifact: inserted[0], created: true };
  }

  private async latestTranscript(tx: Tx, meetingId: string) {
    const [t] = await tx
      .select()
      .from(transcripts)
      .where(eq(transcripts.meetingId, meetingId))
      .orderBy(desc(transcripts.createdAt))
      .limit(1);
    return t ?? null;
  }

  async requestByUser(
    userId: string,
    meetingId: string,
    type: ArtifactType,
    regenerate: boolean,
    correlationId?: string,
  ): Promise<{ created: boolean }> {
    return this.d.db.asUser(userId, async (tx) => {
      const [m] = await tx
        .select()
        .from(meetings)
        .where(
          and(eq(meetings.id, meetingId), eq(meetings.userId, userId), isNull(meetings.deletedAt)),
        );
      if (!m || m.status === "deletion_pending") throw Errors.notFound("Meeting");
      const r = await this.requestInTx(tx, meetingId, userId, type, "user", regenerate);
      if (r.created) {
        await this.d.audit.record(tx, {
          actorType: "user",
          actorId: userId,
          action: `${type}.generation_requested`,
          targetType: "meeting",
          targetId: meetingId,
          correlationId,
          metadata: { version: r.artifact.version, regenerate },
        });
      }
      return { created: r.created };
    });
  }

  /** Auto-generation after transcription. Swallows "not configured" so transcripts still complete. */
  async requestSystem(meetingId: string, type: ArtifactType): Promise<void> {
    if (!this.d.llm) return;
    await this.d.db.asSystem(async (tx) => {
      const [m] = await tx.select().from(meetings).where(eq(meetings.id, meetingId));
      if (!m || m.deletedAt) return;
      await this.requestInTx(tx, meetingId, m.userId, type, "system", false);
    });
  }

  /** Job: generate the artifact version. */
  async process(artifactId: string): Promise<void> {
    const ctx = await this.d.db.asSystem(async (tx) => {
      const [a] = await tx
        .select()
        .from(meetingArtifacts)
        .where(eq(meetingArtifacts.id, artifactId));
      if (!a || a.status === "completed") return null;
      const [m] = await tx.select().from(meetings).where(eq(meetings.id, a.meetingId));
      if (!m || m.deletedAt || m.status === "deletion_pending") return null;
      const [t] = a.transcriptId
        ? await tx.select().from(transcripts).where(eq(transcripts.id, a.transcriptId))
        : [];
      const participants = await tx
        .select({ name: meetingParticipants.displayName, source: meetingParticipants.source })
        .from(meetingParticipants)
        .where(eq(meetingParticipants.meetingId, m.id))
        .limit(200);
      await tx
        .update(meetingArtifacts)
        .set({ status: "processing", updatedAt: new Date() })
        .where(eq(meetingArtifacts.id, a.id));
      return { a, m, t: t ?? null, participants };
    });
    if (!ctx) return;
    const { a, m, t } = ctx;

    // Participants: prefer those the provider saw in the call; fall back to calendar invitees.
    const fromProvider = ctx.participants.filter((p) => p.source === "provider").map((p) => p.name);
    const fromCalendar = ctx.participants.filter((p) => p.source === "calendar").map((p) => p.name);
    const details: MeetingDetails = {
      title: m.title,
      startAt: (m.actualStartAt ?? m.scheduledStartAt).toISOString(),
      endAt: (m.actualEndAt ?? m.scheduledEndAt)?.toISOString() ?? null,
      timezone: m.timezoneAtCreation,
      platform: m.platform,
      participants: fromProvider.length > 0 ? fromProvider : fromCalendar,
      participantsSource:
        fromProvider.length > 0 ? "provider" : fromCalendar.length > 0 ? "calendar" : "none",
    };

    if (!t || t.status !== "completed" || !t.segments) {
      throw new PermanentJobError("transcript_unavailable", "Transcript unavailable");
    }

    let content: SummaryContent | MinutesContent;
    let meta: {
      provider: string | null;
      model: string | null;
      promptVersion: string | null;
      usage: ArtifactRow["usage"];
      isMock: boolean;
    };

    if (t.quality === "insufficient") {
      content =
        a.artifactType === "summary"
          ? SummaryContentSchema.parse({
              purpose: null,
              keyPoints: [],
              decisions: [],
              risks: [],
              nextSteps: [],
              uncertainties: [],
              insufficientSource: true,
              note: INSUFFICIENT_NOTE,
            })
          : MinutesContentSchema.parse({
              meetingDetails: details,
              objective: null,
              discussionPoints: [],
              decisions: [],
              proposals: [],
              actionItems: [],
              risks: [],
              openQuestions: [],
              nextSteps: [],
              nextMeeting: null,
              insufficientSource: true,
              note: INSUFFICIENT_NOTE,
            });
      meta = { provider: "system", model: null, promptVersion: null, usage: null, isMock: false };
    } else {
      if (!this.d.generator || !this.d.llm)
        throw new PermanentJobError("generation_failed", "No LLM configured");
      const metadata = {
        Title: m.title,
        Platform: m.platform,
        "Scheduled start (UTC)": m.scheduledStartAt.toISOString(),
        "Transcript language": t.language ?? "unknown",
      };
      const r =
        a.artifactType === "summary"
          ? await this.d.generator.summary(t.segments, metadata)
          : await this.d.generator.minutes(t.segments, metadata, details);
      content = r.content;
      meta = {
        provider: this.d.llm.name,
        model: this.d.llm.model,
        promptVersion: r.promptVersion,
        usage: r.usage,
        isMock: this.d.llm.isMock || t.isMock,
      };
    }

    const rendered =
      a.artifactType === "summary"
        ? renderSummaryText(SummaryContentSchema.parse(content))
        : renderMinutesText(MinutesContentSchema.parse(content));

    await this.d.db.asSystem(async (tx) => {
      await tx
        .update(meetingArtifacts)
        .set({
          status: "completed",
          content,
          renderedText: rendered,
          provider: meta.provider,
          model: meta.model,
          promptVersion: meta.promptVersion,
          usage: meta.usage,
          isMock: meta.isMock,
          generatedAt: new Date(),
          errorCode: null,
          updatedAt: new Date(),
        })
        .where(eq(meetingArtifacts.id, a.id));
    });
  }

  async markFailed(artifactId: string, code: string): Promise<void> {
    const errorCode = ["generation_invalid_output", "transcript_unavailable"].includes(code)
      ? code
      : "generation_failed";
    await this.d.db.asSystem(async (tx) => {
      const [a] = await tx
        .update(meetingArtifacts)
        .set({ status: "failed", errorCode, updatedAt: new Date() })
        .where(eq(meetingArtifacts.id, artifactId))
        .returning();
      if (a) this.d.metrics.aiFailures.inc({ type: a.artifactType, code: errorCode });
    });
  }

  static isRetryable(err: unknown): boolean {
    return err instanceof ProviderError ? err.retryable : !(err instanceof PermanentJobError);
  }

  // ------------------------------------------------------------------ read API
  async get(userId: string, meetingId: string, type: "summary"): Promise<SummaryArtifact>;
  async get(userId: string, meetingId: string, type: "minutes"): Promise<MinutesArtifact>;
  async get(
    userId: string,
    meetingId: string,
    type: ArtifactType,
  ): Promise<SummaryArtifact | MinutesArtifact> {
    return this.d.db.asUser(userId, async (tx) => {
      const [m] = await tx
        .select()
        .from(meetings)
        .where(
          and(eq(meetings.id, meetingId), eq(meetings.userId, userId), isNull(meetings.deletedAt)),
        );
      if (!m) throw Errors.notFound("Meeting");
      const latest = await this.latest(tx, meetingId, type);
      // Show the newest completed version while a regeneration is in flight.
      const shown =
        latest && latest.status !== "completed"
          ? ((await this.latestCompleted(tx, meetingId, type)) ?? latest)
          : latest;
      const transcript = await this.latestTranscript(tx, meetingId);
      const canGenerate =
        !!this.d.llm &&
        transcript?.status === "completed" &&
        m.status !== "deletion_pending" &&
        !(latest && (latest.status === "pending" || latest.status === "processing"));

      const inFlight = latest && (latest.status === "pending" || latest.status === "processing");
      const status = inFlight ? latest.status : (shown?.status ?? null);
      const errorCode =
        shown?.status === "failed"
          ? shown.errorCode
          : !shown && transcript?.status === "failed"
            ? "transcript_unavailable"
            : !shown && !transcript && m.status === "completed"
              ? null
              : (shown?.errorCode ?? null);
      return {
        id: shown?.id ?? null,
        status: status as SummaryArtifact["status"],
        version: shown?.version ?? null,
        content: shown?.status === "completed" ? (shown.content as never) : null,
        renderedText: shown?.status === "completed" ? shown.renderedText : null,
        generatedAt: shown?.generatedAt?.toISOString() ?? null,
        provider: shown?.provider ?? null,
        model: shown?.model ?? null,
        promptVersion: shown?.promptVersion ?? null,
        errorCode,
        isMock: shown?.isMock ?? false,
        canGenerate,
      };
    });
  }
}
