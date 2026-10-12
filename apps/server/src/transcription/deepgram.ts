import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { ProviderError } from "../lib/errors";
import type { StoredSegment } from "../db/schema";
import type { TranscriptionProvider, TranscriptionRequest, TranscriptionResult } from "./types";

interface DeepgramResponse {
  results?: {
    channels?: Array<{
      detected_language?: string;
      alternatives?: Array<{ transcript?: string }>;
    }>;
    utterances?: Array<{ start: number; end: number; speaker?: number; transcript: string }>;
  };
}

/**
 * Deepgram pre-recorded transcription adapter.
 * STATUS: implemented against Deepgram's documented `/v1/listen` API but NOT verified
 * against a live account in this repository (no credentials). See IMPLEMENTATION_STATUS.md.
 */
export class DeepgramTranscriptionProvider implements TranscriptionProvider {
  readonly name = "deepgram";
  readonly isMock = false;

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = "https://api.deepgram.com",
  ) {}

  async transcribe(req: TranscriptionRequest): Promise<TranscriptionResult> {
    const params = new URLSearchParams({
      model: this.model,
      smart_format: "true",
      diarize: "true",
      utterances: "true",
      punctuate: "true",
    });
    if (req.language) params.set("language", req.language);
    else params.set("detect_language", "true");

    const size = (await stat(req.filePath)).size;
    let res: Response;
    try {
      const init: RequestInit & { duplex: "half" } = {
        method: "POST",
        headers: {
          Authorization: `Token ${this.apiKey}`,
          "Content-Type": req.mimeType,
          "Content-Length": String(size),
        },
        body: Readable.toWeb(createReadStream(req.filePath)) as unknown as RequestInit["body"],
        duplex: "half", // required by Node fetch for streamed request bodies
        signal: AbortSignal.timeout(20 * 60_000),
      };
      res = await this.fetchImpl(`${this.baseUrl}/v1/listen?${params.toString()}`, init);
    } catch (err) {
      throw new ProviderError("transcription_failed", `Deepgram request failed: ${(err as Error).name}`, true);
    }
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      throw new ProviderError("transcription_failed", `Deepgram HTTP ${res.status}`, retryable, res.status);
    }
    const body = (await res.json()) as DeepgramResponse;
    return this.normalize(body);
  }

  normalize(body: DeepgramResponse): TranscriptionResult {
    const channel = body.results?.channels?.[0];
    const utterances = body.results?.utterances ?? [];
    let segments: StoredSegment[];
    if (utterances.length > 0) {
      segments = utterances
        .filter((u) => u.transcript.trim())
        .map((u) => ({
          startMs: Math.round(u.start * 1000),
          endMs: Math.round(u.end * 1000),
          speaker: typeof u.speaker === "number" ? `Speaker ${u.speaker + 1}` : null,
          text: u.transcript.trim(),
        }));
    } else {
      const text = channel?.alternatives?.[0]?.transcript?.trim() ?? "";
      segments = text ? [{ startMs: null, endMs: null, speaker: null, text }] : [];
    }
    return { language: channel?.detected_language ?? null, segments, raw: { utteranceCount: utterances.length } };
  }
}
