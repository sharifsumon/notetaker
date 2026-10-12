import {
  MEETING_STATUSES,
  MEETING_STATUS_LABELS,
  PLATFORM_LABELS,
  PLATFORMS,
  type Me,
  type MeetingListQuery,
} from "@notetaker/shared";
import { useEffect, useState } from "react";
import { useOutletContext, useSearchParams } from "react-router";
import { AddMeetingDialog } from "../components/AddMeetingDialog";
import { MeetingList, MeetingListSkeleton } from "../components/MeetingList";
import { EmptyState, ErrorNotice } from "../components/ui";
import { useMeetings } from "../lib/queries";

const PAGE_SIZE = 20;

/** Full list with search and date/platform/status filters (FR-06). Filters live in the URL. */
export function MeetingsPage() {
  const me = useOutletContext<Me>();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const view = (params.get("view") as MeetingListQuery["view"]) ?? "all";
  const page = Math.max(1, Number(params.get("page") ?? "1") || 1);
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";

  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k !== "page") next.delete("page");
    setParams(next, { replace: true });
  };

  // Debounce the search box.
  useEffect(() => {
    const t = setTimeout(() => {
      if ((params.get("q") ?? "") !== q) set("q", q.trim());
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const query: Partial<MeetingListQuery> = {
    view,
    page,
    pageSize: PAGE_SIZE,
    q: params.get("q") || undefined,
    platform: (params.get("platform") as MeetingListQuery["platform"]) || undefined,
    status: (params.get("status") as MeetingListQuery["status"]) || undefined,
    from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
    to: to ? new Date(new Date(`${to}T00:00:00`).getTime() + 86_400_000).toISOString() : undefined,
  };
  const list = useMeetings(query);
  const filtered = !!(query.q || query.platform || query.status || from || to);
  const totalPages = list.data ? Math.max(1, Math.ceil(list.data.total / PAGE_SIZE)) : 1;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Meetings</h1>
          <p>Search and filter every meeting, then open its recording, summary or minutes.</p>
        </div>
        <AddMeetingDialog />
      </div>

      <form className="filters" role="search" onSubmit={(e) => e.preventDefault()}>
        <div className="field">
          <label htmlFor="f-q">Search by title</label>
          <input
            id="f-q"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="e.g. planning"
          />
        </div>
        <div className="field">
          <label htmlFor="f-view">Show</label>
          <select
            id="f-view"
            value={view}
            onChange={(e) => set("view", e.target.value === "all" ? "" : e.target.value)}
          >
            <option value="all">All meetings</option>
            <option value="upcoming">Upcoming</option>
            <option value="past">Past</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-platform">Platform</label>
          <select
            id="f-platform"
            value={params.get("platform") ?? ""}
            onChange={(e) => set("platform", e.target.value)}
          >
            <option value="">Any platform</option>
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {PLATFORM_LABELS[p]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-status">Status</label>
          <select
            id="f-status"
            value={params.get("status") ?? ""}
            onChange={(e) => set("status", e.target.value)}
          >
            <option value="">Any status</option>
            {MEETING_STATUSES.filter((s) => s !== "deletion_pending").map((s) => (
              <option key={s} value={s}>
                {MEETING_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-from">From date</label>
          <input
            id="f-from"
            type="date"
            value={from}
            onChange={(e) => set("from", e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="f-to">To date</label>
          <input id="f-to" type="date" value={to} onChange={(e) => set("to", e.target.value)} />
        </div>
      </form>

      {list.isLoading ? (
        <MeetingListSkeleton />
      ) : list.isError ? (
        <ErrorNotice error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data!.items.length === 0 ? (
        filtered ? (
          <EmptyState
            title="No meetings match these filters"
            action={
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => (setQ(""), setParams({}, { replace: true }))}
              >
                Clear filters
              </button>
            }
          />
        ) : (
          <EmptyState title="No meetings yet">
            Connect a calendar in Settings or record a meeting link.
          </EmptyState>
        )
      ) : (
        <>
          <MeetingList items={list.data!.items} timezone={me.timezone} />
          <nav className="pager" aria-label="Pagination">
            <span aria-live="polite">
              Page {page} of {totalPages} ({list.data!.total} meetings)
            </span>
            <span className="row">
              <button
                type="button"
                className="btn btn-sm"
                disabled={page <= 1}
                onClick={() => set("page", String(page - 1))}
              >
                Previous page
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={page >= totalPages}
                onClick={() => set("page", String(page + 1))}
              >
                Next page
              </button>
            </span>
          </nav>
        </>
      )}
    </>
  );
}
