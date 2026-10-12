import type { ActionItem, ChunkNotes, MinutesModelOutput, SummaryModelOutput } from "@notetaker/shared";
import type { LlmProvider, StructuredRequest } from "./types";

/**
 * DEVELOPMENT/TEST LLM: a deterministic *extractive* generator. It only copies sentences
 * from the source using simple patterns, so it cannot invent facts. Output is labelled
 * "mock" in the UI; production configuration refuses this provider.
 */
export class MockLlmProvider implements LlmProvider {
  readonly name = "mock";
  readonly model = "mock-extractive-v1";
  readonly isMock = true;

  async generateStructured<T>(req: StructuredRequest<T>): Promise<{ data: T; usage: { inputTokens: number; outputTokens: number } }> {
    const sentences = splitSentences(req.sourceText);
    const x = extract(sentences);
    let data: unknown;
    if (req.task === "summary") {
      const out: SummaryModelOutput = {
        purpose: x.purpose,
        keyPoints: x.other.slice(0, 5),
        decisions: x.decisions,
        risks: x.risks,
        nextSteps: [...x.actions.map((a) => a.task), ...(x.nextMeeting ? [`Next meeting: ${x.nextMeeting}`] : [])],
        uncertainties: x.actions.some((a) => !a.owner) ? ["Some action items have no named owner."] : [],
      };
      data = out;
    } else if (req.task === "minutes") {
      const out: MinutesModelOutput = {
        objective: x.purpose,
        discussionPoints: x.other.slice(0, 6).map((s, i) => ({ topic: `Point ${i + 1}`, summary: s })),
        decisions: x.decisions.map((d) => ({ decision: d, evidence: d.slice(0, 200) })),
        proposals: x.proposals.map((p) => ({ proposal: p, evidence: p.slice(0, 200) })),
        actionItems: x.actions,
        risks: x.risks,
        openQuestions: x.questions,
        nextSteps: x.actions.map((a) => a.task),
        nextMeeting: x.nextMeeting,
      };
      data = out;
    } else {
      const out: ChunkNotes = {
        discussionPoints: x.other.slice(0, 6).map((s, i) => ({ topic: `Point ${i + 1}`, summary: s })),
        decisions: x.decisions.map((d) => ({ decision: d, evidence: d.slice(0, 200) })),
        proposals: x.proposals.map((p) => ({ proposal: p, evidence: p.slice(0, 200) })),
        actionItems: x.actions,
        risks: x.risks,
        openQuestions: x.questions,
        nextSteps: [],
      };
      data = out;
    }
    const parsed = req.schema.parse(data);
    return { data: parsed, usage: { inputTokens: Math.ceil(req.user.length / 4), outputTokens: 0 } };
  }
}

function splitSentences(text: string): string[] {
  return text
    .split(/\n+/)
    .map((l) => l.replace(/^\[[\d:]+\]\s*/, "").replace(/^[^:]{1,40}:\s+/, ""))
    .flatMap((l) => l.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter((s) => s.length > 3)
    .slice(0, 2000);
}

const DAYS = "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|tomorrow|next week|end of (?:the )?(?:day|week|month)";

function extract(sentences: string[]) {
  const decisions: string[] = [];
  const proposals: string[] = [];
  const risks: string[] = [];
  const questions: string[] = [];
  const actions: ActionItem[] = [];
  const other: string[] = [];
  let purpose: string | null = null;
  let nextMeeting: string | null = null;

  for (const s of sentences) {
    const clipped = s.slice(0, 900);
    const goal = /\b(?:goal|purpose|objective)(?: today)? is to ([^.]+)/i.exec(s);
    if (goal?.[1] && !purpose) {
      purpose = capitalize(goal[1].trim());
      continue;
    }
    const next = /next meeting is ([^.]+)/i.exec(s);
    if (next?.[1]) nextMeeting = next[1].trim();

    if (/\b(we agreed|we decided|decision is|agreed to)\b/i.test(s)) decisions.push(clipped);
    else if (/\b(propose|suggest|what if|maybe we)\b/i.test(s)) proposals.push(clipped);

    const named = /\b([A-Z][a-z]+) will ([^.]+)/.exec(s);
    const someone = /\b(?:someone|somebody) should ([^.]+)/i.exec(s);
    if (named?.[1] && named[2] && !["We", "I", "It", "This", "That", "They"].includes(named[1])) {
      actions.push(actionFrom(named[2], named[1], s));
    } else if (someone?.[1]) {
      actions.push(actionFrom(someone[1], null, s));
    }

    if (/\b(risk|blocked|blocker|concern)\b/i.test(s)) risks.push(clipped);
    if (/\b(open question|whether)\b/i.test(s) || s.endsWith("?")) {
      if (s.length > 20) questions.push(clipped);
    }
    if (
      !decisions.includes(clipped) &&
      !proposals.includes(clipped) &&
      !risks.includes(clipped) &&
      !questions.includes(clipped) &&
      !named &&
      !someone
    ) {
      other.push(clipped);
    }
  }
  return { decisions, proposals, risks, questions, actions, other, purpose, nextMeeting };
}

function actionFrom(rest: string, owner: string | null, sentence: string): ActionItem {
  const due = new RegExp(`\\bby (${DAYS})\\b`, "i").exec(rest) ?? new RegExp(`\\b(${DAYS})\\b`, "i").exec(rest);
  const task = rest.replace(new RegExp(`\\s*\\bby (${DAYS})\\b`, "i"), "").replace(/\s*this week$/i, "").trim();
  return {
    task: capitalize(task).slice(0, 900) || "Unspecified task",
    owner,
    dueDate: due?.[1] ?? null,
    status: owner ? "open" : "not_specified",
    evidence: sentence.slice(0, 200),
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
