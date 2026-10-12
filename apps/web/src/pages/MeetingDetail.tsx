import {
  CANCELLABLE_STATUSES,
  describeError,
  MEETING_STATUS_LABELS,
  PLATFORM_LABELS,
  type Me,
  type MeetingDetail,
} from "@notetaker/shared";
import * as Tabs from "@radix-ui/react-tabs";
import {
  ArrowLeft,
  FileText,
  Headphones,
  ListChecks,
  MessageSquareText,
  Trash2,
} from "lucide-react";
import { useEffect } from "react";
import { Link, useNavigate, useOutletContext, useParams, useSearchParams } from "react-router";
import { AudioPlayer } from "../components/AudioPlayer";
import { MinutesTab, SummaryTab, TranscriptTab } from "../components/ArtifactViews";
import { ErrorNotice, errorText, Notice, StatusBadge, useToast } from "../components/ui";
import { ApiError } from "../lib/api";
import { formatDateTime, formatDuration } from "../lib/format";
import { useMeeting, useMeetingAction, useRecording } from "../lib/queries";

const TABS = ["summary", "minutes", "transcript"] as const;
type Tab = (typeof TABS)[number];

function RecordingPanel({ m }: { m: MeetingDetail }) {
  const rec = useRecording(m.id, true);
  const body = () => {
    if (rec.isLoading) return <p className="muted small">Loading…</p>;
    if (rec.isError) return <ErrorNotice error={rec.error} onRetry={() => void rec.refetch()} />;
    const r = rec.data!;
    if (r.status === "ready" && r.streamUrl && r.downloadUrl) {
      return (
        <AudioPlayer
          src={r.streamUrl}
          downloadUrl={r.downloadUrl}
          knownDuration={r.durationSeconds}
          title={m.title}
        />
      );
    }
    if (r.status === "failed")
      return (
        <Notice tone="bad" title="Recording unavailable">
          {describeError(r.errorCode)}
        </Notice>
      );
    if (
      r.status === "processing" ||
      r.status === "pending" ||
      m.status === "recording_processing"
    ) {
      return (
        <Notice tone="wait" title="Recording not available yet">
          The audio is being processed. This page updates automatically.
        </Notice>
      );
    }
    if (m.status === "failed")
      return (
        <Notice tone="bad" title="No recording">
          {m.failureMessage ?? "Recording failed."}
        </Notice>
      );
    return <p className="muted small">The recording appears here after the meeting ends.</p>;
  };
  return (
    <section className="panel" aria-labelledby="rec-title" id="recording">
      <h2 id="rec-title">
        <Headphones size={18} aria-hidden="true" /> Recording
      </h2>
      {body()}
    </section>
  );
}

function LifecycleNotice({ m }: { m: MeetingDetail }) {
  if (m.status === "joining" && m.substatus === "waiting_for_admission") {
    return (
      <Notice tone="wait" title="The bot is waiting to be admitted">
        Ask the host to admit your Notetaker bot (its name ends in “(recording)”) from the meeting
        lobby.
      </Notice>
    );
  }
  if (m.status === "failed") {
    return (
      <Notice tone="bad" title="Recording failed">
        {m.failureMessage ?? "The meeting could not be recorded."}
      </Notice>
    );
  }
  if (m.status === "unsupported") {
    return (
      <Notice tone="bad" title="This meeting can't be recorded">
        {m.failureMessage ?? "The platform or meeting type is not supported."}
      </Notice>
    );
  }
  if (m.status === "queued") {
    return (
      <Notice title="Recording is scheduled">
        The bot joins shortly before the start time. You can cancel until it joins.
      </Notice>
    );
  }
  if (m.status === "in_progress")
    return (
      <Notice tone="live" title="Recording in progress">
        Notes are created after the meeting ends.
      </Notice>
    );
  if (m.status === "deletion_pending")
    return (
      <Notice title="Deletion in progress">This meeting and its data are being deleted.</Notice>
    );
  return null;
}

export function MeetingDetailPage() {
  const me = useOutletContext<Me>();
  const { meetingId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const q = useMeeting(meetingId);
  const actions = useMeetingAction();
  const requested = params.get("tab");
  const tab: Tab = (TABS as readonly string[]).includes(requested ?? "")
    ? (requested as Tab)
    : "summary";
  const loaded = !!q.data;
  useEffect(() => {
    // "Audio / View recording" links land on the player.
    if (loaded && requested === "recording")
      document.getElementById("recording")?.scrollIntoView({ block: "start" });
  }, [loaded, requested]);

  if (q.isLoading) return <p className="muted">Loading meeting…</p>;
  if (q.isError) {
    if (q.error instanceof ApiError && q.error.status === 404) {
      return (
        <div className="stack">
          <h1>Meeting not found</h1>
          <p className="muted">It may have been deleted, or the link is wrong.</p>
          <Link to="/meetings">Back to meetings</Link>
        </div>
      );
    }
    return <ErrorNotice error={q.error} onRetry={() => void q.refetch()} />;
  }
  const m = q.data!;
  const ended =
    new Date(
      m.scheduledEndAt ?? new Date(new Date(m.scheduledStartAt).getTime() + 3600_000),
    ).getTime() < Date.now();
  const tz = me.timezone;
  const duration = formatDuration(m.durationSeconds);

  const register = () =>
    actions.register.mutate(
      { meetingId: m.id },
      { onSuccess: () => toast("Recording scheduled"), onError: (e) => toast(errorText(e), "bad") },
    );
  const cancel = () =>
    window.confirm("Cancel recording for this meeting?") &&
    actions.cancel.mutate(m.id, {
      onSuccess: () => toast("Recording cancelled"),
      onError: (e) => toast(errorText(e), "bad"),
    });
  const remove = () =>
    window.confirm(
      "Delete this meeting, its recording, transcript, summary and minutes? This can't be undone.",
    ) &&
    actions.remove.mutate(m.id, {
      onSuccess: () => {
        toast("Meeting deletion started");
        navigate("/meetings");
      },
      onError: (e) => toast(errorText(e), "bad"),
    });

  return (
    <>
      <div className="detail-head">
        <Link to="/meetings" className="crumb">
          <ArrowLeft size={14} aria-hidden="true" /> Meetings
        </Link>
        <h1>{m.title}</h1>
        <div className="row">
          <StatusBadge status={m.status} ended={ended} substatus={m.substatus} />
          <span>{formatDateTime(m.scheduledStartAt, tz)}</span>
          <span className="muted">{PLATFORM_LABELS[m.platform]}</span>
          {duration && <span className="muted">{duration}</span>}
        </div>
        <div className="row">
          {m.canRegister && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={register}
              disabled={actions.register.isPending}
            >
              Record this meeting
            </button>
          )}
          {m.canCancel && (
            <button
              type="button"
              className="btn"
              onClick={cancel}
              disabled={actions.cancel.isPending}
            >
              Cancel recording
            </button>
          )}
          {m.status !== "deletion_pending" && (
            <button
              type="button"
              className="btn btn-danger"
              onClick={remove}
              disabled={actions.remove.isPending}
            >
              <Trash2 size={16} aria-hidden="true" />
              Delete meeting
            </button>
          )}
        </div>
        <LifecycleNotice m={m} />
      </div>

      <div className="detail-grid">
        <div style={{ minWidth: 0 }}>
          <RecordingPanel m={m} />
          <Tabs.Root value={tab} onValueChange={(v) => setParams({ tab: v }, { replace: true })}>
            <Tabs.List className="tabs-list" aria-label="Meeting notes">
              <Tabs.Trigger value="summary" className="tabs-trigger">
                <FileText size={16} aria-hidden="true" />
                Summary
              </Tabs.Trigger>
              <Tabs.Trigger value="minutes" className="tabs-trigger">
                <ListChecks size={16} aria-hidden="true" />
                Meeting Minutes
              </Tabs.Trigger>
              <Tabs.Trigger value="transcript" className="tabs-trigger">
                <MessageSquareText size={16} aria-hidden="true" />
                Transcript
              </Tabs.Trigger>
            </Tabs.List>
            <Tabs.Content value="summary">
              <SummaryTab
                meetingId={m.id}
                title={m.title}
                meetingCompleted={m.status === "completed"}
              />
            </Tabs.Content>
            <Tabs.Content value="minutes">
              <MinutesTab meetingId={m.id} meetingCompleted={m.status === "completed"} />
            </Tabs.Content>
            <Tabs.Content value="transcript">
              <TranscriptTab meetingId={m.id} />
            </Tabs.Content>
          </Tabs.Root>
        </div>

        <aside>
          <section className="panel" aria-labelledby="facts-title">
            <h2 id="facts-title">Details</h2>
            <dl className="facts">
              <dt>Scheduled</dt>
              <dd>{formatDateTime(m.scheduledStartAt, tz)}</dd>
              {m.actualStartAt && (
                <>
                  <dt>Recorded from</dt>
                  <dd>{formatDateTime(m.actualStartAt, tz)}</dd>
                </>
              )}
              <dt>Source</dt>
              <dd>{m.fromCalendar ? "Calendar" : "Added by link"}</dd>
              {m.registrationSource && (
                <>
                  <dt>Recording</dt>
                  <dd>{m.registrationSource === "auto" ? "Automatic" : "Chosen by you"}</dd>
                </>
              )}
              <dt>Participants</dt>
              <dd>
                {m.participants.length
                  ? m.participants.map((p) => p.displayName).join(", ")
                  : "Not available"}
              </dd>
            </dl>
          </section>
          <section className="panel" aria-labelledby="tl-title">
            <h2 id="tl-title">Status history</h2>
            <ol className="timeline">
              {m.statusHistory.map((h, i) => (
                <li key={i}>
                  <div>
                    {MEETING_STATUS_LABELS[h.to]}
                    <span>
                      {formatDateTime(h.occurredAt, tz)}
                      {h.reasonCode ? `, ${describeError(h.reasonCode) ?? h.reasonCode}` : ""}
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          </section>
          {CANCELLABLE_STATUSES.includes(m.status) && (
            <p className="small muted" style={{ marginTop: "1rem" }}>
              The bot joins as a visible participant and never bypasses the lobby.
            </p>
          )}
        </aside>
      </div>
    </>
  );
}
