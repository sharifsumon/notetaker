import type { StoredSegment } from "../db/schema";

export interface TranscriptionRequest {
  filePath: string;
  mimeType: string;
  durationSeconds: number | null;
  language?: string;
  /** Dev-only scenario hint for the mock provider. */
  mockScenario?: string | null;
}

export interface TranscriptionResult {
  language: string | null;
  /** Speaker labels are provider diarization labels (e.g. "Speaker 1"), never verified identities. */
  segments: StoredSegment[];
  raw?: unknown;
}

/** Speech-to-text adapter (FR-09). */
export interface TranscriptionProvider {
  readonly name: string;
  readonly model: string;
  readonly isMock: boolean;
  transcribe(req: TranscriptionRequest): Promise<TranscriptionResult>;
}

export function segmentsToText(segments: StoredSegment[]): string {
  return segments.map((s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text)).join("\n");
}

export function countWords(segments: StoredSegment[]): number {
  return segments.reduce((n, s) => n + (s.text.trim() ? s.text.trim().split(/\s+/).length : 0), 0);
}
