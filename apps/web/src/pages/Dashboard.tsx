import type { Me } from "@notetaker/shared";
import { Link, useOutletContext } from "react-router";
import { AddMeetingDialog } from "../components/AddMeetingDialog";
import { MeetingList, MeetingListSkeleton } from "../components/MeetingList";
import { EmptyState, ErrorNotice, Notice } from "../components/ui";
import { useCalendars, useMeetings } from "../lib/queries";

export function DashboardPage() {
  const me = useOutletContext<Me>();
  const upcoming = useMeetings({ view: "upcoming", pageSize: 5 });
  const recent = useMeetings({ view: "past", pageSize: 5 });
  const calendars = useCalendars();
  const stats = upcoming.data?.stats ?? recent.data?.stats;
  const noCalendar = calendars.data && calendars.data.items.length === 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p>Upcoming recordings and your latest meeting notes.</p>
        </div>
        <AddMeetingDialog />
      </div>

      {!me.recordingNoticeAcknowledgedAt && (
        <div className="section">
          <Notice tone="wait" title="Finish setup to start recording" actions={<Link className="btn btn-sm" to="/onboarding">Review recording settings</Link>}>
            You need to review the recording notice before any meeting can be recorded.
          </Notice>
        </div>
      )}
      {noCalendar && me.recordingNoticeAcknowledgedAt && (
        <div className="section">
          <Notice title="No calendar connected" actions={<Link className="btn btn-sm" to="/settings">Connect a calendar</Link>}>
            Connect Google or Outlook Calendar to see your Meet and Teams meetings here automatically.
          </Notice>
        </div>
      )}

      <dl className="stats" aria-label="Meeting totals">
        <div>
          <dt>Total meetings</dt>
          <dd>{stats?.total ?? "–"}</dd>
        </div>
        <div>
          <dt>Recordings completed</dt>
          <dd>{stats?.completed ?? "–"}</dd>
        </div>
        <div>
          <dt>Processing</dt>
          <dd>{stats?.processing ?? "–"}</dd>
        </div>
        <div>
          <dt>Failed</dt>
          <dd>{stats?.failed ?? "–"}</dd>
        </div>
      </dl>

      <section className="section" aria-labelledby="up-title">
        <div className="section-head">
          <h2 id="up-title">Upcoming</h2>
          <Link to="/meetings?view=upcoming">All upcoming</Link>
        </div>
        {upcoming.isLoading ? (
          <MeetingListSkeleton rows={3} />
        ) : upcoming.isError ? (
          <ErrorNotice error={upcoming.error} onRetry={() => void upcoming.refetch()} />
        ) : upcoming.data!.items.length === 0 ? (
          <EmptyState title="No upcoming meetings">
            Meetings from connected calendars appear here. You can also record a meeting link directly.
          </EmptyState>
        ) : (
          <MeetingList items={upcoming.data!.items} timezone={me.timezone} />
        )}
      </section>

      <section className="section" aria-labelledby="recent-title">
        <div className="section-head">
          <h2 id="recent-title">Recent</h2>
          <Link to="/meetings?view=past">All past meetings</Link>
        </div>
        {recent.isLoading ? (
          <MeetingListSkeleton rows={3} />
        ) : recent.isError ? (
          <ErrorNotice error={recent.error} onRetry={() => void recent.refetch()} />
        ) : recent.data!.items.length === 0 ? (
          <EmptyState title="No past meetings yet">Recorded meetings and their notes will be listed here.</EmptyState>
        ) : (
          <MeetingList items={recent.data!.items} timezone={me.timezone} />
        )}
      </section>
    </>
  );
}
