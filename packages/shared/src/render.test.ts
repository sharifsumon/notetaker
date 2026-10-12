import { describe, expect, it } from "vitest";
import { MinutesContentSchema } from "./ai-schemas";
import { NOT_SPECIFIED, renderMinutesText, renderSummaryText } from "./render";

const minutes = MinutesContentSchema.parse({
  meetingDetails: {
    title: "Q4 planning",
    startAt: "2026-10-12T09:00:00Z",
    endAt: "2026-10-12T10:00:00Z",
    timezone: "Asia/Dhaka",
    platform: "google_meet",
    participants: ["Asha", "Rafi"],
    participantsSource: "provider",
  },
  objective: "Agree Q4 priorities",
  discussionPoints: [{ topic: "Hiring", summary: "Two roles are open." }],
  decisions: [{ decision: "Ship v2 in November", evidence: "we agreed to ship in November" }],
  proposals: [{ proposal: "Move standup to 10am", evidence: null }],
  actionItems: [
    { task: "Draft the job post", owner: "Asha", dueDate: "Friday", status: "open", evidence: null },
    { task: "Review budget", owner: null, dueDate: null, status: "not_specified", evidence: null },
  ],
  risks: [],
  openQuestions: ["Who owns QA?"],
  nextSteps: ["Share notes"],
  nextMeeting: null,
});

describe("renderMinutesText", () => {
  const text = renderMinutesText(minutes);

  it("preserves headings and action items", () => {
    for (const h of ["MEETING DETAILS", "OBJECTIVE", "DISCUSSION POINTS", "DECISIONS", "ACTION ITEMS", "OPEN QUESTIONS", "NEXT STEPS"]) {
      expect(text).toContain(h);
    }
    expect(text).toContain("1. Draft the job post");
    expect(text).toContain("Owner: Asha");
  });

  it("renders unknown owners and dates as Not specified (never invented)", () => {
    expect(text).toContain(`Owner: ${NOT_SPECIFIED}`);
    expect(text).toContain(`Due: ${NOT_SPECIFIED}`);
    expect(text).toContain(`NEXT MEETING: ${NOT_SPECIFIED}`);
  });

  it("keeps proposals separate from decisions", () => {
    const decisionsIdx = text.indexOf("DECISIONS");
    const proposalsIdx = text.indexOf("PROPOSALS");
    expect(text.slice(decisionsIdx, proposalsIdx)).toContain("Ship v2 in November");
    expect(text.slice(decisionsIdx, proposalsIdx)).not.toContain("standup");
  });

  it("renders in the meeting timezone", () => {
    expect(text).toMatch(/Date\/time: 12 Oct 2026, 15:00/);
  });

  it("is plain text (no markdown/HTML)", () => {
    expect(text).not.toMatch(/[<>*#]/);
  });

  it("renders an insufficient-source note instead of content", () => {
    const t = renderMinutesText({ ...minutes, insufficientSource: true, note: "Too short." });
    expect(t).toContain("Too short.");
    expect(t).not.toContain("ACTION ITEMS");
  });
});

describe("renderSummaryText", () => {
  it("renders insufficient summaries as an explanation", () => {
    expect(
      renderSummaryText({
        purpose: null,
        keyPoints: [],
        decisions: [],
        risks: [],
        nextSteps: [],
        uncertainties: [],
        insufficientSource: true,
        note: "No reliable summary.",
      }),
    ).toBe("No reliable summary.");
  });
});
