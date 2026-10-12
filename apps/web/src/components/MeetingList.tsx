import { PLATFORM_LABELS, type MeetingRow } from "@notetaker/shared";
import { FileText, Headphones, ListChecks, Video } from "lucide-react";
import { Link } from "react-router";
import { formatDay, formatDuration, formatTime, tzAbbrev } from "../lib/format";
import { StatusBadge } from "./ui";

function hasEnded(m: MeetingRow): boolean {
  const end = m.scheduledEndAt ? new Date(m.scheduledEndAt) : new Date(new Date(m.scheduledStartAt).getTime() + 3600_000);
  return end.getTime() < Date.now();
}

const AVAIL_TEXT = { ready: "", processing: " (processing)", failed: " (failed)", none: " (not available yet)" } as const;

function ArtifactLink({
  to,
  avail,
  icon,
  label,
  meetingTitle,
}: {
  to: string;
  avail: MeetingRow["recording"];
  icon: React.ReactNode;
  label: string;
  meetingTitle: string;
}) {
  // Links stay enabled: the detail page explains processing/failed/unavailable states (BRD 5.3).
  return (
    <Link
      to={to}
      className="btn btn-quiet btn-sm artifact-link"
      data-availability={avail}
      aria-label={`${label} for ${meetingTitle}${AVAIL_TEXT[avail]}`}
      title={`${label}${AVAIL_TEXT[avail]}`}
    >
      {icon}
      {label}
    </Link>
  );
}

export function MeetingList({ items, timezone }: { items: MeetingRow[]; timezone: string }) {
  return (
    <ul className="meetings">
      {items.map((m) => {
        const duration = formatDuration(m.durationSeconds);
        return (
          <li key={m.id} className="meeting-row">
            <div className="meeting-when">
              <strong>{formatDay(m.scheduledStartAt, timezone)}</strong>
              <span>
                {formatTime(m.scheduledStartAt, timezone)} {tzAbbrev(m.scheduledStartAt, timezone)}
              </span>
            </div>
            <div className="meeting-main">
              <Link className="meeting-title" to={`/meetings/${m.id}`}>
                {m.title}
              </Link>
              <div className="meeting-meta">
                <StatusBadge status={m.status} ended={hasEnded(m)} />
                <span className="platform">
                  <Video size={14} aria-hidden="true" />
                  {PLATFORM_LABELS[m.platform]}
                </span>
                {duration && <span>{duration}</span>}
                {m.registrationSource === "auto" && <span>Auto-recorded</span>}
              </div>
            </div>
            <div className="meeting-actions">
              <ArtifactLink
                to={`/meetings/${m.id}?tab=recording`}
                avail={m.recording}
                icon={<Headphones size={15} aria-hidden="true" />}
                label="Recording"
                meetingTitle={m.title}
              />
              <ArtifactLink
                to={`/meetings/${m.id}?tab=summary`}
                avail={m.summary !== "none" ? m.summary : m.transcript === "none" ? "none" : m.transcript}
                icon={<FileText size={15} aria-hidden="true" />}
                label="Summary"
                meetingTitle={m.title}
              />
              <ArtifactLink
                to={`/meetings/${m.id}?tab=minutes`}
                avail={m.minutes !== "none" ? m.minutes : m.transcript === "none" ? "none" : m.transcript}
                icon={<ListChecks size={15} aria-hidden="true" />}
                label="Meeting Minutes"
                meetingTitle={m.title}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function MeetingListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="meetings" aria-busy="true" aria-label="Loading meetings">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" />
      ))}
    </div>
  );
}
