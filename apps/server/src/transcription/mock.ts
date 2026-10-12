import type { StoredSegment } from "../db/schema";
import type { TranscriptionProvider, TranscriptionRequest, TranscriptionResult } from "./types";

/**
 * Realistic development fixture transcript. The mock STT provider returns it for any
 * audio, so the downstream pipeline (summary/minutes) can be exercised without paid APIs.
 * Clearly labelled as mock data in the UI. Refused by configuration in production.
 */
export const FIXTURE_TRANSCRIPT: StoredSegment[] = [
  { startMs: 0, endMs: 6000, speaker: "Speaker 1", text: "Thanks everyone for joining. The goal today is to agree the launch plan for the mobile onboarding redesign." },
  { startMs: 6000, endMs: 14000, speaker: "Speaker 2", text: "Design is mostly done. The remaining work is the accessibility review and the copy for the consent screen." },
  { startMs: 14000, endMs: 21000, speaker: "Speaker 1", text: "Okay. Priya will finish the accessibility review by Friday." },
  { startMs: 21000, endMs: 29000, speaker: "Speaker 3", text: "On the backend side, the analytics events are ready, but we are blocked on the legal review of the data retention wording." },
  { startMs: 29000, endMs: 36000, speaker: "Speaker 1", text: "That is a risk for the launch date. Someone should follow up with legal this week." },
  { startMs: 36000, endMs: 44000, speaker: "Speaker 2", text: "I could propose that we ship behind a feature flag first, then enable it for ten percent of users." },
  { startMs: 44000, endMs: 52000, speaker: "Speaker 1", text: "We agreed to launch behind a feature flag. Marco will set up the flag configuration." },
  { startMs: 52000, endMs: 60000, speaker: "Speaker 3", text: "One open question is whether we need a separate consent screen for users in the EU." },
  { startMs: 60000, endMs: 66000, speaker: "Speaker 1", text: "Good point, we will revisit that next meeting. Next meeting is Thursday at 3 pm." },
];

export class MockTranscriptionProvider implements TranscriptionProvider {
  readonly name = "mock";
  readonly model = "mock-fixture-v1";
  readonly isMock = true;

  async transcribe(req: TranscriptionRequest): Promise<TranscriptionResult> {
    if (req.mockScenario === "empty-transcript") return { language: null, segments: [] };
    if (req.mockScenario === "short-transcript") {
      return { language: "en", segments: [{ startMs: 0, endMs: 2000, speaker: "Speaker 1", text: "Can you hear me?" }] };
    }
    return { language: "en", segments: FIXTURE_TRANSCRIPT.map((s) => ({ ...s })) };
  }
}
