import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  InvalidTransitionError,
  MEETING_STATUSES,
  MEETING_TRANSITIONS,
  MEETING_STATUS_LABELS,
} from "./status";

describe("meeting state machine", () => {
  it("every status has a label and a transition entry", () => {
    for (const s of MEETING_STATUSES) {
      expect(MEETING_STATUS_LABELS[s]).toBeTruthy();
      expect(MEETING_TRANSITIONS[s]).toBeDefined();
    }
  });

  it("allows the happy path", () => {
    const path = ["scheduled", "queued", "joining", "in_progress", "recording_processing", "completed"] as const;
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it("rejects backwards / out-of-order transitions", () => {
    expect(canTransition("in_progress", "joining")).toBe(false);
    expect(canTransition("completed", "in_progress")).toBe(false);
    expect(canTransition("completed", "failed")).toBe(false);
    expect(canTransition("scheduled", "in_progress")).toBe(false);
    expect(() => assertTransition("recording_processing", "joining")).toThrow(InvalidTransitionError);
  });

  it("does not allow a completed recording to be marked failed (FR-07)", () => {
    expect(canTransition("completed", "failed")).toBe(false);
  });

  it("deletion is terminal", () => {
    expect(MEETING_TRANSITIONS.deletion_pending).toHaveLength(0);
    for (const s of MEETING_STATUSES) {
      if (s !== "deletion_pending") expect(canTransition(s, "deletion_pending")).toBe(true);
    }
  });

  it("only transitions to known statuses", () => {
    for (const s of MEETING_STATUSES) {
      for (const t of MEETING_TRANSITIONS[s]) expect(MEETING_STATUSES).toContain(t);
    }
  });
});
