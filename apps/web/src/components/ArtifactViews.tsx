import {
  describeError,
  NOT_SPECIFIED,
  PLATFORM_LABELS,
  type Me,
  type MinutesArtifact,
  type MinutesContent,
  type Platform,
  type SummaryArtifact,
  type SummaryContent,
  type Transcript,
} from "@notetaker/shared";
import { AlertTriangle, Copy, FileText, RefreshCw, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useOutletContext } from "react-router";
import { copyText } from "../lib/clipboard";
import { formatClock, formatDateTime } from "../lib/format";
import { useGenerate, useMinutes, useSummary, useTranscript } from "../lib/queries";
import { ErrorNotice, errorText, Notice, useToast } from "./ui";

function Disclaimer({ isMock }: { isMock: boolean }) {
  return (
    <p className="disclaimer">
      <AlertTriangle size={15} aria-hidden="true" />
      <span>
        AI-generated notes may contain errors. Review them before sharing.
        {isMock &&
          " These notes were produced by a development mock provider, not a real AI model."}
      </span>
    </p>
  );
}

function List({ items, empty = "None recorded" }: { items: string[]; empty?: string }) {
  if (items.length === 0) return <p className="none">{empty}</p>;
  return (
    <ul>
      {items.map((x, i) => (
        <li key={i}>{x}</li>
      ))}
    </ul>
  );
}

function Unknown({ value }: { value: string | null }) {
  return value ? <>{value}</> : <span className="unknown">{NOT_SPECIFIED}</span>;
}

function GeneratedMeta({ a }: { a: SummaryArtifact | MinutesArtifact }) {
  const me = useOutletContext<Me | undefined>();
  if (!a.generatedAt) return null;
  return (
    <span className="meta">
      Version {a.version}, generated {formatDateTime(a.generatedAt, me?.timezone ?? "UTC")}
      {a.model ? ` with ${a.model}` : ""}
    </span>
  );
}

/** Shared state handling for summary/minutes: processing, failed, unavailable, not generated. */
function ArtifactState({
  a,
  kind,
  onGenerate,
  generating,
  meetingCompleted,
}: {
  a: SummaryArtifact | MinutesArtifact;
  kind: "Summary" | "Minutes";
  onGenerate: () => void;
  generating: boolean;
  meetingCompleted: boolean;
}) {
  const inFlight = a.status === "pending" || a.status === "processing";
  if (inFlight && !a.content) {
    return (
      <Notice tone="wait" title={`${kind} processing`}>
        <p>This usually takes under a minute. The page updates automatically.</p>
      </Notice>
    );
  }
  if (a.status === "failed" && !a.content) {
    return (
      <Notice
        tone="bad"
        title={`${kind} could not be generated`}
        actions={
          a.canGenerate && (
            <button type="button" className="btn btn-sm" onClick={onGenerate} disabled={generating}>
              <RefreshCw size={15} aria-hidden="true" />
              Try again
            </button>
          )
        }
      >
        <p>{describeError(a.errorCode) ?? "Generation failed."}</p>
      </Notice>
    );
  }
  if (!a.content) {
    if (a.errorCode === "transcript_unavailable") {
      return (
        <Notice tone="bad" title={`A reliable ${kind.toLowerCase()} can't be generated`}>
          <p>
            There is no usable transcript for this meeting, so no notes were created. Nothing has
            been made up.
          </p>
        </Notice>
      );
    }
    if (a.canGenerate) {
      return (
        <Notice
          title={`No ${kind.toLowerCase()} yet`}
          actions={
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={onGenerate}
              disabled={generating}
            >
              <Sparkles size={15} aria-hidden="true" />
              Generate {kind.toLowerCase()}
            </button>
          }
        >
          <p>Generate it from this meeting’s transcript.</p>
        </Notice>
      );
    }
    return (
      <Notice title={`${kind} not available yet`}>
        <p>
          {meetingCompleted
            ? "The transcript is still being prepared. This page updates automatically."
            : `A ${kind.toLowerCase()} is created after the meeting is recorded and transcribed.`}
        </p>
      </Notice>
    );
  }
  return null;
}

// ---------------------------------------------------------------- summary
export function SummaryDocument({ s, title }: { s: SummaryContent; title: string }) {
  if (s.insufficientSource) {
    return (
      <article className="sheet">
        <h2>{title}</h2>
        <p className="none">
          {s.note ?? "A reliable summary could not be generated for this meeting."}
        </p>
      </article>
    );
  }
  return (
    <article className="sheet" aria-label={`Summary of ${title}`}>
      <h2>{title}</h2>
      <h3>Purpose</h3>
      {s.purpose ? <p>{s.purpose}</p> : <p className="unknown">{NOT_SPECIFIED}</p>}
      <h3>Key discussion points</h3>
      <List items={s.keyPoints} />
      <h3>Decisions</h3>
      <List items={s.decisions} />
      <h3>Risks and blockers</h3>
      <List items={s.risks} />
      <h3>Next steps</h3>
      <List items={s.nextSteps} />
      {s.uncertainties.length > 0 && (
        <>
          <h3>Uncertain or missing information</h3>
          <List items={s.uncertainties} />
        </>
      )}
    </article>
  );
}

export function SummaryTab({
  meetingId,
  title,
  meetingCompleted,
}: {
  meetingId: string;
  title: string;
  meetingCompleted: boolean;
}) {
  const q = useSummary(meetingId, true);
  const gen = useGenerate(meetingId, "summary");
  const toast = useToast();
  if (q.isLoading) return <p className="muted">Loading summary…</p>;
  if (q.isError) return <ErrorNotice error={q.error} onRetry={() => void q.refetch()} />;
  const a = q.data!;
  const run = (regenerate: boolean) =>
    gen.mutate(regenerate, { onError: (e) => toast(errorText(e), "bad") });
  return (
    <div className="stack">
      <ArtifactState
        a={a}
        kind="Summary"
        onGenerate={() => run(false)}
        generating={gen.isPending}
        meetingCompleted={meetingCompleted}
      />
      {a.content && (
        <>
          <div className="tab-toolbar">
            <GeneratedMeta a={a} />
            <div className="actions">
              {(a.status === "pending" || a.status === "processing") && (
                <span className="status tone-wait">Regenerating…</span>
              )}
              {a.canGenerate && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    window.confirm(
                      "Generate a new version of the summary? The current version stays until the new one is ready.",
                    ) && run(true)
                  }
                  disabled={gen.isPending}
                >
                  <RefreshCw size={15} aria-hidden="true" />
                  Regenerate
                </button>
              )}
            </div>
          </div>
          {a.status === "failed" && (
            <Notice tone="bad">
              The latest regeneration failed; showing the previous version.
            </Notice>
          )}
          <SummaryDocument s={a.content} title={title} />
          <Disclaimer isMock={a.isMock} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- minutes
const ACTION_STATUS = {
  open: "Open",
  completed: "Completed",
  not_specified: NOT_SPECIFIED,
} as const;

export function MinutesDocument({ m }: { m: MinutesContent }) {
  const d = m.meetingDetails;
  return (
    <article className="sheet" aria-label={`Minutes of ${d.title}`}>
      <h2>Minutes: {d.title}</h2>
      <p className="sub">
        {formatDateTime(d.startAt, d.timezone)},{" "}
        {PLATFORM_LABELS[d.platform as Platform] ?? d.platform}
      </p>
      <h3>Participants</h3>
      {d.participants.length ? (
        <p>
          {d.participants.join(", ")}
          {d.participantsSource === "calendar" && (
            <span className="sub"> (from the calendar invitation; attendance not confirmed)</span>
          )}
        </p>
      ) : (
        <p className="unknown">{NOT_SPECIFIED}</p>
      )}
      {m.insufficientSource ? (
        <p className="none">
          {m.note ?? "The transcript was insufficient to produce reliable minutes."}
        </p>
      ) : (
        <>
          <h3>Objective</h3>
          {m.objective ? <p>{m.objective}</p> : <p className="unknown">{NOT_SPECIFIED}</p>}
          <h3>Discussion points</h3>
          {m.discussionPoints.length ? (
            <ol>
              {m.discussionPoints.map((p, i) => (
                <li key={i}>
                  <strong>{p.topic}.</strong> {p.summary}
                </li>
              ))}
            </ol>
          ) : (
            <p className="none">None recorded</p>
          )}
          <h3>Decisions</h3>
          <List items={m.decisions.map((x) => x.decision)} />
          <h3>Proposals not yet decided</h3>
          <List items={m.proposals.map((x) => x.proposal)} />
          <h3>Action items</h3>
          {m.actionItems.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Task</th>
                    <th scope="col">Owner</th>
                    <th scope="col">Due</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {m.actionItems.map((a, i) => (
                    <tr key={i}>
                      <td>
                        {a.task}
                        {a.evidence && <span className="evidence">“{a.evidence}”</span>}
                      </td>
                      <td>
                        <Unknown value={a.owner} />
                      </td>
                      <td>
                        <Unknown value={a.dueDate} />
                      </td>
                      <td>
                        {a.status === "not_specified" ? (
                          <span className="unknown">{NOT_SPECIFIED}</span>
                        ) : (
                          ACTION_STATUS[a.status]
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="none">None recorded</p>
          )}
          <h3>Risks and blockers</h3>
          <List items={m.risks} />
          <h3>Open questions</h3>
          <List items={m.openQuestions} />
          <h3>Next steps</h3>
          <List items={m.nextSteps} />
          <h3>Next meeting</h3>
          {m.nextMeeting ? <p>{m.nextMeeting}</p> : <p className="unknown">{NOT_SPECIFIED}</p>}
          {m.note && <p className="sub">{m.note}</p>}
        </>
      )}
    </article>
  );
}

export function MinutesTab({
  meetingId,
  meetingCompleted,
}: {
  meetingId: string;
  meetingCompleted: boolean;
}) {
  const q = useMinutes(meetingId, true);
  const gen = useGenerate(meetingId, "minutes");
  const toast = useToast();
  const [plain, setPlain] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const autoRequested = useRef(false);
  const a = q.data;

  // BRD 5.4: opening Meeting Minutes generates them if they don't exist yet.
  useEffect(() => {
    if (a && !a.content && a.status === null && a.canGenerate && !autoRequested.current) {
      autoRequested.current = true;
      gen.mutate(false, { onError: (e) => toast(errorText(e), "bad") });
    }
  }, [a, gen, toast]);

  useEffect(() => {
    if (copyFailed && textRef.current) {
      textRef.current.focus();
      textRef.current.select();
    }
  }, [copyFailed, plain]);

  if (q.isLoading) return <p className="muted">Loading minutes…</p>;
  if (q.isError) return <ErrorNotice error={q.error} onRetry={() => void q.refetch()} />;
  const art = a!;
  const run = (regenerate: boolean) =>
    gen.mutate(regenerate, { onError: (e) => toast(errorText(e), "bad") });

  const copy = async () => {
    if (!art.renderedText) return;
    const ok = await copyText(art.renderedText);
    if (ok) {
      setCopyFailed(false);
      toast("Minutes copied to clipboard");
    } else {
      setCopyFailed(true);
      setPlain(true);
    }
  };

  return (
    <div className="stack">
      <ArtifactState
        a={art}
        kind="Minutes"
        onGenerate={() => run(false)}
        generating={gen.isPending}
        meetingCompleted={meetingCompleted}
      />
      {art.content && art.renderedText && (
        <>
          <div className="tab-toolbar">
            <GeneratedMeta a={art} />
            <div className="actions">
              {(art.status === "pending" || art.status === "processing") && (
                <span className="status tone-wait">Regenerating…</span>
              )}
              <button type="button" className="btn btn-primary" onClick={() => void copy()}>
                <Copy size={16} aria-hidden="true" />
                Copy minutes
              </button>
              <button
                type="button"
                className="btn"
                aria-pressed={plain}
                onClick={() => setPlain((p) => !p)}
              >
                <FileText size={16} aria-hidden="true" />
                {plain ? "Formatted view" : "Plain text"}
              </button>
              {art.canGenerate && (
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    window.confirm(
                      "Generate a new version of the minutes? The current version stays until the new one is ready.",
                    ) && run(true)
                  }
                  disabled={gen.isPending}
                >
                  <RefreshCw size={16} aria-hidden="true" />
                  Regenerate
                </button>
              )}
            </div>
          </div>
          {copyFailed && (
            <Notice tone="bad" title="Your browser blocked clipboard access">
              <p>
                The minutes are selected in the box below. Press Ctrl+C (or ⌘C on a Mac) to copy
                them.
              </p>
            </Notice>
          )}
          {art.status === "failed" && (
            <Notice tone="bad">
              The latest regeneration failed; showing the previous version.
            </Notice>
          )}
          {plain ? (
            <div className="field">
              <label htmlFor="minutes-plain">
                Minutes as plain text (exactly what Copy minutes copies)
              </label>
              <textarea
                id="minutes-plain"
                ref={textRef}
                className="plain-text"
                readOnly
                value={art.renderedText}
                rows={24}
              />
            </div>
          ) : (
            <MinutesDocument m={art.content} />
          )}
          <Disclaimer isMock={art.isMock} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- transcript
export function TranscriptTab({ meetingId }: { meetingId: string }) {
  const q = useTranscript(meetingId, true);
  if (q.isLoading) return <p className="muted">Loading transcript…</p>;
  if (q.isError) return <ErrorNotice error={q.error} onRetry={() => void q.refetch()} />;
  const t: Transcript = q.data!;
  if (t.status === "pending" || t.status === "processing") {
    return (
      <Notice tone="wait" title="Transcription in progress">
        The page updates automatically.
      </Notice>
    );
  }
  if (t.status === "failed") {
    return (
      <Notice tone="bad" title="Transcription failed">
        {describeError(t.errorCode)}
      </Notice>
    );
  }
  if (!t.status)
    return (
      <Notice title="No transcript yet">
        A transcript is created after the meeting is recorded.
      </Notice>
    );
  return (
    <div className="stack">
      <p className="small muted">
        Speaker labels are assigned automatically and are not verified identities.
        {t.language && ` Detected language: ${t.language}.`}
        {t.isMock && " This transcript is development fixture data."}
      </p>
      <ol className="transcript" aria-label="Transcript">
        {t.segments.map((s, i) => (
          <li key={i}>
            <span className="ts">{s.startMs !== null ? formatClock(s.startMs / 1000) : ""}</span>
            <div>
              {s.speaker && <span className="speaker">{s.speaker}</span>}
              <span className="text">{s.text}</span>
            </div>
          </li>
        ))}
      </ol>
      {t.totalSegments > t.segments.length && (
        <p className="small muted">
          Showing the first {t.segments.length} of {t.totalSegments} segments.
        </p>
      )}
    </div>
  );
}
