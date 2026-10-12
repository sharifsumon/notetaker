import {
  ChunkNotesSchema,
  MinutesModelOutputSchema,
  SummaryModelOutputSchema,
  type ChunkNotes,
  type MeetingDetails,
  type MinutesContent,
  type MinutesModelOutput,
  type SummaryContent,
} from "@notetaker/shared";
import type { StoredSegment } from "../db/schema";
import {
  buildUserPrompt,
  CHUNK_SYSTEM,
  MINUTES_PROMPT_VERSION,
  MINUTES_SYSTEM,
  SUMMARY_PROMPT_VERSION,
  SUMMARY_SYSTEM,
} from "./prompts";
import type { LlmProvider, LlmUsage } from "./types";

export interface GeneratorConfig {
  chunkChars: number;
  maxTranscriptChars: number;
  maxOutputTokens: number;
}

export interface GenerationResult<T> {
  content: T;
  usage: { inputTokens: number; outputTokens: number; calls: number };
  promptVersion: string;
  truncated: boolean;
}

function fmtTime(ms: number | null): string {
  if (ms === null) return "";
  const s = Math.floor(ms / 1000);
  return `[${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}] `;
}

/** Formats segments as transcript lines and applies the maximum transcript size policy. */
export function prepareTranscript(segments: StoredSegment[], maxChars: number): { text: string; truncated: boolean } {
  const lines = segments.map((s) => `${fmtTime(s.startMs)}${s.speaker ? `${s.speaker}: ` : ""}${s.text}`);
  let text = lines.join("\n");
  let truncated = false;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }
  return { text, truncated };
}

/** Splits on line boundaries into chunks no larger than `size` characters. */
export function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const piece = line.length > size ? line.slice(0, size) : line;
    if (current.length + piece.length + 1 > size && current) {
      chunks.push(current);
      current = "";
    }
    current += (current ? "\n" : "") + piece;
  }
  if (current) chunks.push(current);
  return chunks;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Grounding guard (BRD 11): owners, due dates and evidence must literally appear in the
 * source; otherwise they are replaced with null ("Not specified") rather than trusted.
 */
export function groundMinutes(out: MinutesModelOutput, sourceText: string): MinutesModelOutput {
  const src = norm(sourceText);
  const appears = (v: string | null) => (v && src.includes(norm(v)) ? v : null);
  return {
    ...out,
    actionItems: out.actionItems.map((a) => {
      const owner = appears(a.owner);
      return {
        ...a,
        owner,
        dueDate: appears(a.dueDate),
        evidence: appears(a.evidence),
        status: a.status === "open" && !owner ? "not_specified" : a.status,
      };
    }),
    decisions: out.decisions.map((d) => ({ ...d, evidence: appears(d.evidence) })),
    proposals: out.proposals.map((p) => ({ ...p, evidence: appears(p.evidence) })),
  };
}

export class ArtifactGenerator {
  constructor(
    private readonly llm: LlmProvider,
    private readonly cfg: GeneratorConfig,
  ) {}

  private addUsage(total: { inputTokens: number; outputTokens: number; calls: number }, u: LlmUsage) {
    total.inputTokens += u.inputTokens;
    total.outputTokens += u.outputTokens;
    total.calls += 1;
  }

  /** Map step for long transcripts: returns combined notes, or null for single-chunk input. */
  private async mapChunks(
    text: string,
    metadata: Record<string, string>,
    usage: { inputTokens: number; outputTokens: number; calls: number },
  ): Promise<string | null> {
    const chunks = chunkText(text, this.cfg.chunkChars);
    if (chunks.length <= 1) return null;
    const notes: ChunkNotes[] = [];
    for (const [i, chunk] of chunks.entries()) {
      const r = await this.llm.generateStructured({
        task: "chunk_notes",
        system: CHUNK_SYSTEM,
        user: buildUserPrompt({
          instruction: `Extract notes from part ${i + 1} of ${chunks.length} of the meeting transcript.`,
          metadata,
          source: chunk,
        }),
        schema: ChunkNotesSchema,
        schemaName: "chunk_notes",
        maxOutputTokens: this.cfg.maxOutputTokens,
        sourceText: chunk,
      });
      this.addUsage(usage, r.usage);
      notes.push(r.data);
    }
    return notes.map((n, i) => `Notes from part ${i + 1}:\n${JSON.stringify(n)}`).join("\n\n");
  }

  async summary(segments: StoredSegment[], metadata: Record<string, string>): Promise<GenerationResult<SummaryContent>> {
    const { text, truncated } = prepareTranscript(segments, this.cfg.maxTranscriptChars);
    const usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
    const combined = await this.mapChunks(text, metadata, usage);
    const r = await this.llm.generateStructured({
      task: "summary",
      system: SUMMARY_SYSTEM,
      user: buildUserPrompt({
        instruction: combined
          ? "Summarize the meeting using these structured notes extracted from consecutive parts of its transcript."
          : "Summarize this meeting transcript.",
        metadata,
        source: combined ?? text,
      }),
      schema: SummaryModelOutputSchema,
      schemaName: "meeting_summary",
      maxOutputTokens: this.cfg.maxOutputTokens,
      sourceText: text,
    });
    this.addUsage(usage, r.usage);
    const uncertainties = [...r.data.uncertainties];
    if (truncated) uncertainties.push("The transcript exceeded the size limit; only the first part was summarized.");
    return {
      content: { ...r.data, uncertainties, insufficientSource: false, note: null },
      usage,
      promptVersion: SUMMARY_PROMPT_VERSION,
      truncated,
    };
  }

  async minutes(
    segments: StoredSegment[],
    metadata: Record<string, string>,
    details: MeetingDetails,
  ): Promise<GenerationResult<MinutesContent>> {
    const { text, truncated } = prepareTranscript(segments, this.cfg.maxTranscriptChars);
    const usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
    const combined = await this.mapChunks(text, metadata, usage);
    const r = await this.llm.generateStructured({
      task: "minutes",
      system: MINUTES_SYSTEM,
      user: buildUserPrompt({
        instruction: combined
          ? "Produce Minutes of Meeting using these structured notes extracted from consecutive parts of the transcript. Merge duplicates."
          : "Produce Minutes of Meeting for this transcript.",
        metadata,
        source: combined ?? text,
      }),
      schema: MinutesModelOutputSchema,
      schemaName: "meeting_minutes",
      maxOutputTokens: this.cfg.maxOutputTokens,
      sourceText: text,
    });
    this.addUsage(usage, r.usage);
    const grounded = groundMinutes(r.data, text);
    return {
      content: {
        ...grounded,
        meetingDetails: details,
        insufficientSource: false,
        note: truncated ? "The transcript exceeded the size limit; only the first part was used." : null,
      },
      usage,
      promptVersion: MINUTES_PROMPT_VERSION,
      truncated,
    };
  }
}
