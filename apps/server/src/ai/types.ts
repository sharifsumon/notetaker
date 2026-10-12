import type { ZodType } from "zod";

export type LlmTask = "summary" | "minutes" | "chunk_notes";

export interface StructuredRequest<T> {
  task: LlmTask;
  system: string;
  user: string;
  schema: ZodType<T>;
  schemaName: string;
  maxOutputTokens: number;
  /** The untrusted source text; used by the extractive mock provider only. */
  sourceText: string;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

/** LLM adapter (BRD 11). The model/provider is configurable. */
export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  readonly isMock: boolean;
  generateStructured<T>(req: StructuredRequest<T>): Promise<{ data: T; usage: LlmUsage }>;
}
