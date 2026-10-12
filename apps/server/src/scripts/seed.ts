/**
 * DEVELOPMENT/TEST seed: creates two demo users with fixture meetings covering every
 * state the UI must render. Refuses to run in production.
 * Usage: pnpm db:seed  (then sign in via "Dev login" with demo@example.com)
 */
import {
  MinutesContentSchema,
  renderMinutesText,
  renderSummaryText,
  SummaryContentSchema,
} from "@notetaker/shared";
import { and, eq } from "drizzle-orm";
import { MockLlmProvider } from "../ai/mock-llm";
import { ArtifactGenerator } from "../ai/generator";
import { loadEnv } from "../config/env";
import { Db } from "../db/client";
import {
  authIdentities,
  meetingArtifacts,
  meetings,
  meetingStatusEvents,
  recordings,
  transcripts,
  users,
} from "../db/schema";
import { TokenCipher } from "../lib/crypto";
import { FIXTURE_TRANSCRIPT } from "../transcription/mock";

const env = loadEnv();
if (env.NODE_ENV === "production") {
  console.error("Refusing to seed in production");
  process.exit(1);
}
const db = new Db(env.DATABASE_URL, 2);
const cipher = new TokenCipher(env.TOKEN_ENCRYPTION_KEYS, env.TOKEN_ENCRYPTION_ACTIVE_KEY);
const gen = new ArtifactGenerator(new MockLlmProvider(), {
  chunkChars: 48_000,
  maxTranscriptChars: 600_000,
  maxOutputTokens: 4096,
});
const H = 3_600_000;

async function ensureUser(email: string, name: string) {
  return db.asSystem(async (tx) => {
    const [existing] = await tx
      .select({ id: users.id })
      .from(authIdentities)
      .innerJoin(users, eq(users.id, authIdentities.userId))
      .where(
        and(eq(authIdentities.provider, "dev"), eq(authIdentities.providerSubject, `dev:${email}`)),
      );
    if (existing) return existing.id;
    const [u] = await tx
      .insert(users)
      .values({
        email,
        displayName: name,
        timezone: "Asia/Dhaka",
        autoRegister: false,
        recordingNoticeAcknowledgedAt: new Date(),
      })
      .returning();
    await tx.insert(authIdentities).values({
      userId: u!.id,
      provider: "dev",
      providerSubject: `dev:${email}`,
      emailAtProvider: email,
    });
    return u!.id;
  });
}

async function seedMeetings(userId: string) {
  const now = Date.now();
  const specs = [
    {
      title: "Mobile onboarding launch plan",
      platform: "google_meet" as const,
      offset: -26 * H,
      status: "completed",
      full: true,
    },
    {
      title: "Weekly engineering sync",
      platform: "microsoft_teams" as const,
      offset: -3 * 24 * H,
      status: "completed",
      full: false,
    },
    {
      title: "Vendor demo (bot not admitted)",
      platform: "microsoft_teams" as const,
      offset: -50 * H,
      status: "failed",
    },
    {
      title: "Customer interview",
      platform: "google_meet" as const,
      offset: 20 * H,
      status: "queued",
    },
    {
      title: "Design review",
      platform: "google_meet" as const,
      offset: 44 * H,
      status: "scheduled",
    },
    {
      title: "Board prep [mock:admission-timeout]",
      platform: "microsoft_teams" as const,
      offset: 70 * H,
      status: "scheduled",
    },
  ];
  await db.asSystem(async (tx) => {
    const existing = await tx
      .select({ id: meetings.id })
      .from(meetings)
      .where(eq(meetings.userId, userId))
      .limit(1);
    if (existing.length) return;
    for (const [i, s] of specs.entries()) {
      const url =
        s.platform === "google_meet"
          ? `https://meet.google.com/abc-defg-hi${"jklmnop"[i]}`
          : `https://teams.microsoft.com/meet/12345678${i}`;
      const start = new Date(now + s.offset);
      const [m] = await tx
        .insert(meetings)
        .values({
          userId,
          title: s.title,
          platform: s.platform,
          encryptedMeetingUrl: cipher.encrypt(url, `meeting-url:${userId}`),
          scheduledStartAt: start,
          scheduledEndAt: new Date(start.getTime() + H),
          actualStartAt: s.status === "completed" ? start : null,
          actualEndAt: s.status === "completed" ? new Date(start.getTime() + 55 * 60_000) : null,
          timezoneAtCreation: "Asia/Dhaka",
          status: s.status,
          failureCode: s.status === "failed" ? "bot_admission_timeout" : null,
          registrationSource: s.status === "scheduled" ? null : "manual",
        })
        .returning();
      await tx
        .insert(meetingStatusEvents)
        .values({ userId, meetingId: m!.id, oldStatus: null, newStatus: s.status, source: "seed" });
      if (s.status !== "completed") continue;
      // Seeded meetings have recording metadata but no audio file ("Recording file is missing"
      // is shown if played). Use the mock bot provider for a full end-to-end recording.
      const [rec] = await tx
        .insert(recordings)
        .values({
          userId,
          meetingId: m!.id,
          storageProvider: "local",
          status: "failed",
          errorCode: "recording_unavailable",
          durationSeconds: 3300,
        })
        .returning();
      const [t] = await tx
        .insert(transcripts)
        .values({
          userId,
          meetingId: m!.id,
          recordingId: rec!.id,
          status: "completed",
          language: "en",
          provider: "mock",
          model: "seed",
          segments: FIXTURE_TRANSCRIPT,
          text: FIXTURE_TRANSCRIPT.map((x) => x.text).join("\n"),
          wordCount: 180,
          quality: "ok",
          isMock: true,
        })
        .returning();
      if (!s.full) continue;
      const meta = { Title: s.title };
      const sum = await gen.summary(FIXTURE_TRANSCRIPT, meta);
      const min = await gen.minutes(FIXTURE_TRANSCRIPT, meta, {
        title: s.title,
        startAt: start.toISOString(),
        endAt: null,
        timezone: "Asia/Dhaka",
        platform: s.platform,
        participants: [],
        participantsSource: "none",
      });
      for (const [type, content, text] of [
        ["summary", sum.content, renderSummaryText(SummaryContentSchema.parse(sum.content))],
        ["minutes", min.content, renderMinutesText(MinutesContentSchema.parse(min.content))],
      ] as const) {
        await tx.insert(meetingArtifacts).values({
          userId,
          meetingId: m!.id,
          transcriptId: t!.id,
          artifactType: type,
          version: 1,
          status: "completed",
          content,
          renderedText: text,
          provider: "mock",
          model: "mock-extractive-v1",
          promptVersion: type === "summary" ? sum.promptVersion : min.promptVersion,
          isMock: true,
          generatedAt: new Date(),
          createdBy: "system",
        });
      }
    }
  });
}

const demo = await ensureUser("demo@example.com", "Demo User");
const other = await ensureUser("other@example.com", "Other User");
await seedMeetings(demo);
await seedMeetings(other);
await db.close();
console.log("Seeded demo@example.com and other@example.com (sign in with Dev login).");
