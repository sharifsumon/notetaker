import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max);

/**
 * Summary content produced by the LLM. Validated before storage.
 * `insufficientSource` is set (by the system, not the model) when the transcript cannot
 * support a reliable summary — in that case the lists are empty and `note` explains why.
 */
export const SummaryContentSchema = z.object({
  purpose: text(1000).nullable(),
  keyPoints: z.array(text(1000)).max(30),
  decisions: z.array(text(1000)).max(30),
  risks: z.array(text(1000)).max(30),
  nextSteps: z.array(text(1000)).max(30),
  uncertainties: z.array(text(1000)).max(20).default([]),
  insufficientSource: z.boolean().default(false),
  note: z.string().max(1000).nullable().default(null),
});
export type SummaryContent = z.infer<typeof SummaryContentSchema>;

/** Model-facing schema for summary (system-owned fields excluded). */
export const SummaryModelOutputSchema = SummaryContentSchema.pick({
  purpose: true,
  keyPoints: true,
  decisions: true,
  risks: true,
  nextSteps: true,
  uncertainties: true,
});
export type SummaryModelOutput = z.infer<typeof SummaryModelOutputSchema>;

export const ACTION_ITEM_STATUSES = ["open", "completed", "not_specified"] as const;

export const ActionItemSchema = z.object({
  task: text(1000),
  owner: text(200).nullable(),
  dueDate: text(100).nullable(),
  status: z.enum(ACTION_ITEM_STATUSES),
  evidence: z.string().trim().max(500).nullable(),
});
export type ActionItem = z.infer<typeof ActionItemSchema>;

/** Fields the model is allowed to produce for Minutes of Meeting. */
export const MinutesModelOutputSchema = z.object({
  objective: text(1000).nullable(),
  discussionPoints: z.array(z.object({ topic: text(300), summary: text(2000) })).max(40),
  decisions: z
    .array(z.object({ decision: text(1000), evidence: z.string().trim().max(500).nullable() }))
    .max(40),
  proposals: z
    .array(z.object({ proposal: text(1000), evidence: z.string().trim().max(500).nullable() }))
    .max(40),
  actionItems: z.array(ActionItemSchema).max(60),
  risks: z.array(text(1000)).max(30),
  openQuestions: z.array(text(1000)).max(30),
  nextSteps: z.array(text(1000)).max(30),
  nextMeeting: text(500).nullable(),
});
export type MinutesModelOutput = z.infer<typeof MinutesModelOutputSchema>;

/**
 * Meeting details come from trusted metadata (never from the model), so the model cannot
 * invent attendance, dates or the platform.
 */
export const MeetingDetailsSchema = z.object({
  title: z.string(),
  startAt: z.string().nullable(),
  endAt: z.string().nullable(),
  timezone: z.string(),
  platform: z.string(),
  participants: z.array(z.string()),
  participantsSource: z.enum(["provider", "calendar", "none"]),
});
export type MeetingDetails = z.infer<typeof MeetingDetailsSchema>;

export const MinutesContentSchema = MinutesModelOutputSchema.extend({
  meetingDetails: MeetingDetailsSchema,
  insufficientSource: z.boolean().default(false),
  note: z.string().max(1000).nullable().default(null),
});
export type MinutesContent = z.infer<typeof MinutesContentSchema>;

/** Intermediate per-chunk notes used for long transcripts (map step). */
export const ChunkNotesSchema = z.object({
  discussionPoints: z.array(z.object({ topic: text(300), summary: text(2000) })).max(30),
  decisions: z
    .array(z.object({ decision: text(1000), evidence: z.string().trim().max(500).nullable() }))
    .max(30),
  proposals: z
    .array(z.object({ proposal: text(1000), evidence: z.string().trim().max(500).nullable() }))
    .max(30),
  actionItems: z.array(ActionItemSchema).max(40),
  risks: z.array(text(1000)).max(20),
  openQuestions: z.array(text(1000)).max(20),
  nextSteps: z.array(text(1000)).max(20),
});
export type ChunkNotes = z.infer<typeof ChunkNotesSchema>;
