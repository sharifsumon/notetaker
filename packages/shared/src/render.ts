import type { MinutesContent, SummaryContent } from "./ai-schemas";
import { PLATFORM_LABELS, type Platform } from "./status";

export const NOT_SPECIFIED = "Not specified";

const DATE_OPTS: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZoneName: "short",
};

export function formatDateTime(iso: string | null, timeZone: string): string {
  if (!iso) return NOT_SPECIFIED;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return NOT_SPECIFIED;
  try {
    return new Intl.DateTimeFormat("en-GB", { ...DATE_OPTS, timeZone }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-GB", { ...DATE_OPTS, timeZone: "UTC" }).format(d);
  }
}

function platformLabel(p: string): string {
  return PLATFORM_LABELS[p as Platform] ?? p;
}

function list(lines: string[], items: string[]): void {
  if (items.length === 0) lines.push("- None recorded");
  for (const i of items) lines.push(`- ${i}`);
}

const ACTION_STATUS_LABEL = { open: "Open", completed: "Completed", not_specified: NOT_SPECIFIED };

/**
 * Renders Minutes of Meeting as clean plain text. This exact text is shown in the UI's
 * plain-text view and placed on the clipboard by "Copy minutes" (FR-12).
 */
export function renderMinutesText(m: MinutesContent): string {
  const d = m.meetingDetails;
  const lines: string[] = [];
  lines.push(`MINUTES OF MEETING: ${d.title}`);
  lines.push("");
  lines.push("MEETING DETAILS");
  lines.push(`Date/time: ${formatDateTime(d.startAt, d.timezone)}`);
  lines.push(`Platform: ${platformLabel(d.platform)}`);
  lines.push(
    `Participants: ${d.participants.length > 0 ? d.participants.join(", ") : NOT_SPECIFIED}`,
  );
  lines.push("");
  if (m.insufficientSource) {
    lines.push("NOTE");
    lines.push(m.note ?? "The transcript was insufficient to produce reliable minutes.");
    return lines.join("\n");
  }
  lines.push("OBJECTIVE");
  lines.push(m.objective ?? NOT_SPECIFIED);
  lines.push("");
  lines.push("DISCUSSION POINTS");
  if (m.discussionPoints.length === 0) lines.push("- None recorded");
  m.discussionPoints.forEach((p, i) => lines.push(`${i + 1}. ${p.topic}: ${p.summary}`));
  lines.push("");
  lines.push("DECISIONS");
  list(
    lines,
    m.decisions.map((x) => x.decision),
  );
  lines.push("");
  lines.push("PROPOSALS (NOT YET DECIDED)");
  list(
    lines,
    m.proposals.map((x) => x.proposal),
  );
  lines.push("");
  lines.push("ACTION ITEMS");
  if (m.actionItems.length === 0) lines.push("- None recorded");
  m.actionItems.forEach((a, i) => {
    lines.push(`${i + 1}. ${a.task}`);
    lines.push(`   Owner: ${a.owner ?? NOT_SPECIFIED}`);
    lines.push(`   Due: ${a.dueDate ?? NOT_SPECIFIED}`);
    lines.push(`   Status: ${ACTION_STATUS_LABEL[a.status]}`);
  });
  lines.push("");
  lines.push("RISKS / BLOCKERS");
  list(lines, m.risks);
  lines.push("");
  lines.push("OPEN QUESTIONS");
  list(lines, m.openQuestions);
  lines.push("");
  lines.push("NEXT STEPS");
  list(lines, m.nextSteps);
  lines.push("");
  lines.push(`NEXT MEETING: ${m.nextMeeting ?? NOT_SPECIFIED}`);
  lines.push("");
  lines.push("AI-generated minutes may contain errors. Please review before sharing.");
  return lines.join("\n");
}

export function renderSummaryText(s: SummaryContent): string {
  if (s.insufficientSource) {
    return s.note ?? "A reliable summary could not be generated for this meeting.";
  }
  const lines: string[] = [];
  lines.push("PURPOSE");
  lines.push(s.purpose ?? NOT_SPECIFIED);
  const sections: Array<[string, string[]]> = [
    ["KEY DISCUSSION POINTS", s.keyPoints],
    ["DECISIONS", s.decisions],
    ["RISKS / BLOCKERS", s.risks],
    ["NEXT STEPS", s.nextSteps],
  ];
  for (const [h, items] of sections) {
    lines.push("");
    lines.push(h);
    list(lines, items);
  }
  if (s.uncertainties.length > 0) {
    lines.push("");
    lines.push("UNCERTAIN OR MISSING INFORMATION");
    list(lines, s.uncertainties);
  }
  return lines.join("\n");
}
