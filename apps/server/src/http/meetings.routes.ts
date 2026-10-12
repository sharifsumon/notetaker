import {
  GenerateArtifactSchema,
  MeetingDetailSchema,
  MeetingListQuerySchema,
  MeetingListResponseSchema,
  MinutesArtifactSchema,
  RecordingSchema,
  RegisterMeetingSchema,
  SummaryArtifactSchema,
  TranscriptQuerySchema,
  TranscriptSchema,
  type Recording,
  type Transcript,
} from "@notetaker/shared";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Router, type RequestHandler, type Response } from "express";
import { pipeline } from "node:stream/promises";
import type { Container } from "../container";
import { meetings, recordings, transcripts } from "../db/schema";
import { Errors } from "../lib/errors";
import { route, uuidParams } from "../lib/http";
import type { ByteRange } from "../storage/types";
import { requireUser } from "./middleware";

const MeetingParams = uuidParams("meetingId");

/** Parses a single `bytes=` range. Returns null for absent/unsupported ranges, "invalid" if unsatisfiable. */
export function parseRange(header: string | undefined, size: number): ByteRange | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // multi-range etc.: serve full content
  const [, s, e] = m;
  let start: number;
  let end: number;
  if (s === "" && e === "") return "invalid";
  if (s === "") {
    const suffix = Number(e);
    if (suffix === 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(s);
    end = e === "" ? size - 1 : Math.min(Number(e), size - 1);
  }
  if (start > end || start >= size) return "invalid";
  return { start, end };
}

function safeFilename(title: string, date: Date): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60)
    .toLowerCase();
  return `meeting-${date.toISOString().slice(0, 10)}${slug ? `-${slug}` : ""}.m4a`;
}

export function meetingRoutes(
  c: Container,
  limits: { registration: RequestHandler; generation: RequestHandler; download: RequestHandler },
): Router {
  const r = Router();

  route(
    r,
    {
      method: "get",
      path: "/meetings",
      summary: "List the current user's meetings (paginated, filterable)",
      tag: "Meetings",
      auth: "user",
      query: MeetingListQuerySchema,
      middleware: [requireUser],
      responses: { 200: { description: "OK", schema: MeetingListResponseSchema } },
    },
    (req, _res, { query }) => c.meetings.list(req.user!.id, query),
  );

  route(
    r,
    {
      method: "post",
      path: "/meetings/register",
      summary:
        "Register a meeting for recording: an existing synced meeting ({meetingId}) or an ad-hoc Meet/Teams link. Idempotent.",
      tag: "Meetings",
      auth: "user",
      body: RegisterMeetingSchema,
      middleware: [requireUser, limits.registration],
      responses: { 200: { description: "Registered", schema: MeetingDetailSchema } },
    },
    (req, _res, { body }) =>
      "meetingId" in body
        ? c.meetings.registerExisting(req.user!.id, body.meetingId, req.requestId)
        : c.meetings.registerAdhoc(req.user!.id, body, req.requestId),
  );

  route(
    r,
    {
      method: "get",
      path: "/meetings/:meetingId",
      summary: "Meeting details incl. status timeline",
      tag: "Meetings",
      auth: "user",
      params: MeetingParams,
      middleware: [requireUser],
      responses: { 200: { description: "OK", schema: MeetingDetailSchema } },
    },
    (req, _res, { params }) => c.meetings.detail(req.user!.id, params.meetingId),
  );

  route(
    r,
    {
      method: "post",
      path: "/meetings/:meetingId/cancel",
      summary: "Cancel recording before the bot is in the meeting",
      tag: "Meetings",
      auth: "user",
      params: MeetingParams,
      middleware: [requireUser, limits.registration],
      responses: { 200: { description: "OK", schema: MeetingDetailSchema } },
    },
    (req, _res, { params }) => c.meetings.cancel(req.user!.id, params.meetingId, req.requestId),
  );

  route(
    r,
    {
      method: "delete",
      path: "/meetings/:meetingId",
      summary: "Request deletion of a meeting and all its recordings/derived data (asynchronous)",
      tag: "Meetings",
      auth: "user",
      params: MeetingParams,
      middleware: [requireUser],
      responses: { 202: { description: "Deletion queued" } },
    },
    async (req, res, { params }) => {
      await c.meetings.requestDeletion(req.user!.id, params.meetingId, req.requestId);
      res.status(202).json({ status: "deletion_pending" });
    },
  );

  // ---------------------------------------------------------------- recording
  const loadRecording = (userId: string, meetingId: string) =>
    c.db.asUser(userId, async (tx) => {
      const [m] = await tx
        .select()
        .from(meetings)
        .where(and(eq(meetings.id, meetingId), eq(meetings.userId, userId), isNull(meetings.deletedAt)));
      if (!m) throw Errors.notFound("Meeting");
      const [rec] = await tx.select().from(recordings).where(eq(recordings.meetingId, meetingId));
      return { m, rec: rec ?? null };
    });

  route(
    r,
    {
      method: "get",
      path: "/meetings/:meetingId/recording",
      summary: "Recording metadata and authorized playback/download URLs",
      tag: "Recording",
      auth: "user",
      params: MeetingParams,
      middleware: [requireUser],
      responses: { 200: { description: "OK", schema: RecordingSchema } },
    },
    async (req, _res, { params }): Promise<Recording> => {
      const { rec, m } = await loadRecording(req.user!.id, params.meetingId);
      const ready = rec?.status === "ready" && m.status !== "deletion_pending";
      return {
        status: (rec?.status as Recording["status"]) ?? null,
        mimeType: rec?.mimeType ?? null,
        durationSeconds: rec?.durationSeconds ?? null,
        fileSizeBytes: rec?.fileSizeBytes ?? null,
        // Same-origin API URLs; each request is authorized again (no storage URLs exposed here).
        streamUrl: ready ? `/api/v1/meetings/${m.id}/recording/stream` : null,
        downloadUrl: ready ? `/api/v1/meetings/${m.id}/recording/download` : null,
        errorCode: rec?.errorCode ?? null,
      };
    },
  );

  const serveRecording = async (req: Parameters<RequestHandler>[0], res: Response, meetingId: string, download: boolean) => {
    const { rec, m } = await loadRecording(req.user!.id, meetingId);
    if (!rec || rec.status !== "ready" || !rec.storageKey || m.status === "deletion_pending") {
      throw Errors.conflict("recording_not_available", "Recording not available yet");
    }
    const filename = safeFilename(m.title, m.scheduledStartAt);
    if (download) {
      await c.db.asSystem((tx) =>
        c.audit.record(tx, { actorType: "user", actorId: req.user!.id, action: "recording.downloaded", targetType: "meeting", targetId: m.id, correlationId: req.requestId }),
      );
    }
    res.setHeader("Cache-Control", "private, no-store");
    if (c.storage.supportsSignedUrls) {
      const url = await c.storage.signedUrl(rec.storageKey, {
        expiresInSeconds: c.env.SIGNED_URL_TTL_SECONDS,
        contentType: rec.mimeType ?? "audio/mp4",
        downloadFilename: download ? filename : undefined,
      });
      res.redirect(302, url); // short-lived, issued after the ownership check; never logged
      return;
    }
    const stat = await c.storage.stat(rec.storageKey);
    if (!stat) throw Errors.conflict("recording_not_available", "Recording file is missing");
    const range = parseRange(req.header("range"), stat.sizeBytes);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", rec.mimeType ?? "audio/mp4");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `${download ? "attachment" : "inline"}; filename="${filename}"`);
    if (range === "invalid") {
      res.status(416).setHeader("Content-Range", `bytes */${stat.sizeBytes}`);
      res.end();
      return;
    }
    if (range) {
      res.status(206);
      res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${stat.sizeBytes}`);
      res.setHeader("Content-Length", String(range.end - range.start + 1));
    } else {
      res.setHeader("Content-Length", String(stat.sizeBytes));
    }
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    await pipeline(await c.storage.openRead(rec.storageKey, range ?? undefined), res);
  };

  route(
    r,
    {
      method: "get",
      path: "/meetings/:meetingId/recording/stream",
      summary: "Stream the recording (supports HTTP Range)",
      tag: "Recording",
      auth: "user",
      params: MeetingParams,
      middleware: [requireUser, limits.download],
      responses: { 200: { description: "Audio", contentType: "audio/mp4" }, 206: { description: "Partial audio" } },
    },
    (req, res, { params }) => serveRecording(req, res, params.meetingId, false),
  );

  route(
    r,
    {
      method: "get",
      path: "/meetings/:meetingId/recording/download",
      summary: "Download the recording",
      tag: "Recording",
      auth: "user",
      params: MeetingParams,
      middleware: [requireUser, limits.download],
      responses: { 200: { description: "Audio file", contentType: "audio/mp4" } },
    },
    (req, res, { params }) => serveRecording(req, res, params.meetingId, true),
  );

  // ---------------------------------------------------------------- transcript
  route(
    r,
    {
      method: "get",
      path: "/meetings/:meetingId/transcript",
      summary: "Transcript segments (paginated)",
      tag: "Artifacts",
      auth: "user",
      params: MeetingParams,
      query: TranscriptQuerySchema,
      middleware: [requireUser],
      responses: { 200: { description: "OK", schema: TranscriptSchema } },
    },
    (req, _res, { params, query }) =>
      c.db.asUser(req.user!.id, async (tx): Promise<Transcript> => {
        const [m] = await tx
          .select({ id: meetings.id })
          .from(meetings)
          .where(and(eq(meetings.id, params.meetingId), eq(meetings.userId, req.user!.id), isNull(meetings.deletedAt)));
        if (!m) throw Errors.notFound("Meeting");
        const [t] = await tx
          .select()
          .from(transcripts)
          .where(eq(transcripts.meetingId, params.meetingId))
          .orderBy(desc(transcripts.createdAt))
          .limit(1);
        const segs = t?.status === "completed" ? (t.segments ?? []) : [];
        return {
          status: (t?.status as Transcript["status"]) ?? null,
          language: t?.language ?? null,
          provider: t?.provider ?? null,
          segments: segs.slice(query.offset, query.offset + query.limit),
          totalSegments: segs.length,
          speakerLabelsVerified: false,
          errorCode: t?.errorCode ?? null,
          isMock: t?.isMock ?? false,
        };
      }),
  );

  // ---------------------------------------------------------------- summary / minutes
  for (const type of ["summary", "minutes"] as const) {
    route(
      r,
      {
        method: "get",
        path: `/meetings/:meetingId/${type}`,
        summary: type === "summary" ? "AI summary for the meeting" : "Minutes of Meeting (MoM) for the meeting",
        tag: "Artifacts",
        auth: "user",
        params: MeetingParams,
        middleware: [requireUser],
        responses: { 200: { description: "OK", schema: type === "summary" ? SummaryArtifactSchema : MinutesArtifactSchema } },
      },
      (req, _res, { params }) =>
        type === "summary"
          ? c.artifacts.get(req.user!.id, params.meetingId, "summary")
          : c.artifacts.get(req.user!.id, params.meetingId, "minutes"),
    );

    route(
      r,
      {
        method: "post",
        path: `/meetings/:meetingId/${type}/generate`,
        summary: `Generate (or explicitly regenerate) the ${type}. Idempotent while a generation is in flight.`,
        tag: "Artifacts",
        auth: "user",
        params: MeetingParams,
        body: GenerateArtifactSchema,
        middleware: [requireUser, limits.generation],
        responses: { 202: { description: "Generation queued or already in progress" } },
      },
      async (req, res, { params, body }) => {
        const r2 = await c.artifacts.requestByUser(req.user!.id, params.meetingId, type, body.regenerate, req.requestId);
        res.status(202);
        return type === "summary"
          ? { created: r2.created, artifact: await c.artifacts.get(req.user!.id, params.meetingId, "summary") }
          : { created: r2.created, artifact: await c.artifacts.get(req.user!.id, params.meetingId, "minutes") };
      },
    );
  }

  return r;
}
