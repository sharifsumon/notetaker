import type { CalendarConnection, CalendarProvider } from "@notetaker/shared";
import { RefreshCw, Unplug } from "lucide-react";
import { useCalendarActions, useCalendars } from "../lib/queries";
import { errorText, ErrorNotice, Notice, useToast } from "./ui";

const NAMES: Record<CalendarProvider, string> = {
  google_calendar: "Google Calendar",
  microsoft_calendar: "Microsoft Outlook Calendar",
};

function ConnectionState({ c }: { c: CalendarConnection }) {
  if (c.status === "reconnect_required") return <span className="status tone-bad">Reconnect needed</span>;
  if (c.status === "error") return <span className="status tone-wait">Last sync failed</span>;
  if (c.syncInProgress) return <span className="status tone-wait">Syncing…</span>;
  return <span className="status tone-ok">Connected</span>;
}

export function CalendarConnections() {
  const q = useCalendars();
  const a = useCalendarActions();
  const toast = useToast();
  if (q.isLoading) return <p className="muted">Loading calendar connections…</p>;
  if (q.isError) return <ErrorNotice error={q.error} onRetry={() => void q.refetch()} />;
  const data = q.data!;
  const providers: CalendarProvider[] = ["google_calendar", "microsoft_calendar"];

  return (
    <div>
      {providers.map((p) => {
        const conns = data.items.filter((c) => c.provider === p);
        const available = data.available.includes(p);
        return (
          <div key={p} className="conn">
            <div className="stack" style={{ gap: "0.35rem" }}>
              <strong>{NAMES[p]}</strong>
              {conns.length === 0 && (
                <span className="small muted">{available ? "Not connected" : "Not available on this server (OAuth not configured)"}</span>
              )}
              {conns.map((c) => (
                <div key={c.id} className="row small">
                  <ConnectionState c={c} />
                  <span>{c.accountEmail ?? "Connected account"}</span>
                  <span className="muted">
                    {c.lastSyncedAt ? `Last synced ${new Date(c.lastSyncedAt).toLocaleString()}` : "Not synced yet"}
                  </span>
                </div>
              ))}
              {conns.some((c) => c.status === "reconnect_required") && (
                <Notice tone="bad">Calendar access was revoked or expired. Reconnect to keep meetings in sync.</Notice>
              )}
            </div>
            <div className="row">
              {conns.map((c) => (
                <span key={c.id} className="row">
                  {c.status !== "reconnect_required" && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => a.sync.mutate(c.id, { onSuccess: () => toast("Sync started"), onError: (e) => toast(errorText(e), "bad") })}
                      disabled={c.syncInProgress || a.sync.isPending}
                    >
                      <RefreshCw size={15} aria-hidden="true" />
                      Sync now
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => {
                      if (window.confirm(`Disconnect ${NAMES[p]}? Tokens are deleted and unrecorded upcoming meetings from it are removed.`)) {
                        a.disconnect.mutate(c.id, { onSuccess: () => toast(`${NAMES[p]} disconnected`) });
                      }
                    }}
                  >
                    <Unplug size={15} aria-hidden="true" />
                    Disconnect
                  </button>
                </span>
              ))}
              {available && (conns.length === 0 || conns.some((c) => c.status === "reconnect_required")) && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => a.connect.mutate(p, { onError: (e) => toast(errorText(e), "bad") })}
                  disabled={a.connect.isPending}
                >
                  {conns.length ? "Reconnect" : "Connect"}
                </button>
              )}
            </div>
          </div>
        );
      })}
      <p className="small muted" style={{ marginTop: "0.75rem" }}>
        Notetaker asks only for read access to your calendar events, to find Meet and Teams links. Connecting a calendar is
        separate from signing in.
      </p>
    </div>
  );
}
