import { describe, expect, it } from "vitest";
import { DeepgramTranscriptionProvider } from "../transcription/deepgram";
import { parseRange } from "./meetings.routes";

describe("HTTP Range parsing", () => {
  it.each([
    ["bytes=0-99", { start: 0, end: 99 }],
    ["bytes=100-", { start: 100, end: 999 }],
    ["bytes=-100", { start: 900, end: 999 }],
    ["bytes=0-5000", { start: 0, end: 999 }],
  ])("%s", (h, expected) => expect(parseRange(h, 1000)).toEqual(expected));

  it("handles absent, unsupported and unsatisfiable ranges", () => {
    expect(parseRange(undefined, 1000)).toBeNull();
    expect(parseRange("bytes=0-1,5-6", 1000)).toBeNull();
    expect(parseRange("bytes=2000-", 1000)).toBe("invalid");
    expect(parseRange("bytes=-0", 1000)).toBe("invalid");
    expect(parseRange("bytes=5-1", 1000)).toBe("invalid");
  });
});

describe("Deepgram response normalization", () => {
  const dg = new DeepgramTranscriptionProvider("k", "nova-3");
  it("maps utterances to diarized segments with unverified speaker labels", () => {
    const r = dg.normalize({
      results: {
        channels: [{ detected_language: "en", alternatives: [{ transcript: "hello there" }] }],
        utterances: [{ start: 0.5, end: 1.2, speaker: 0, transcript: " hello there " }],
      },
    });
    expect(r.language).toBe("en");
    expect(r.segments).toEqual([
      { startMs: 500, endMs: 1200, speaker: "Speaker 1", text: "hello there" },
    ]);
  });
  it("returns no segments for silence", () => {
    expect(
      dg.normalize({ results: { channels: [{ alternatives: [{ transcript: "" }] }] } }).segments,
    ).toEqual([]);
  });
});
