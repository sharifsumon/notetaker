import type { Me } from "@notetaker/shared";
import { useState } from "react";
import { Navigate, useOutletContext } from "react-router";
import { ErrorNotice, errorText, useToast } from "../components/ui";
import { useAdminJobs, useAdminOverview, useRetryJob } from "../lib/queries";

type Health = {
  ok?: boolean;
  name?: string;
  model?: string;
  mock?: boolean;
  detail?: string;
} | null;

function HealthRow({ label, h }: { label: string; h: Health }) {
  const state =
    h === null
      ? "Not configured"
      : h.ok === false
        ? "Unhealthy"
        : h.ok === true
          ? "Healthy"
          : "Configured";
  const tone = h === null ? "idle" : h.ok === false ? "bad" : "ok";
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>
        <span className={`status tone-${tone}`}>{state}</span>
      </td>
      <td>{h ? [h.name, h.model, h.mock ? "(mock)" : null].filter(Boolean).join(" ") : "–"}</td>
    </tr>
  );
}

/** Operations view (FR-15): health and job state only. No access to meeting content. */
export function AdminPage() {
  const me = useOutletContext<Me>();
  const isAdmin = me.role === "admin";
  const [status, setStatus] = useState("failed");
  const overview = useAdminOverview(isAdmin);
  const jobs = useAdminJobs(status, isAdmin);
  const retry = useRetryJob();
  const toast = useToast();
  if (!isAdmin) return <Navigate to="/" replace />;

  const p = (overview.data?.providers ?? {}) as Record<string, Health>;
  const counts = (overview.data?.jobs ?? []) as Array<{ type: string; status: string; n: number }>;
  const byType = new Map<string, Record<string, number>>();
  for (const c of counts) byType.set(c.type, { ...(byType.get(c.type) ?? {}), [c.status]: c.n });

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div>
          <h1>Operations</h1>
          <p>Provider health and background jobs. Meeting content is not visible here.</p>
        </div>
      </div>
      <section aria-labelledby="h-title" className="stack">
        <h2 id="h-title">Providers</h2>
        {overview.isError ? (
          <ErrorNotice error={overview.error} onRetry={() => void overview.refetch()} />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <tbody>
                <HealthRow label="Database" h={p.database ?? null} />
                <HealthRow label="Storage" h={p.storage ?? null} />
                <HealthRow label="Meeting bot" h={p.meetingBot ?? null} />
                <HealthRow label="Speech-to-text" h={p.speechToText ?? null} />
                <HealthRow label="AI generation" h={p.llm ?? null} />
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section aria-labelledby="q-title" className="stack">
        <h2 id="q-title">Jobs by type (last 7 days and open)</h2>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Type</th>
                {["pending", "running", "succeeded", "failed"].map((s) => (
                  <th key={s} scope="col">
                    {s[0]!.toUpperCase() + s.slice(1)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...byType.entries()].map(([type, c]) => (
                <tr key={type}>
                  <th scope="row">{type}</th>
                  <td>{(c.pending ?? 0) + (c.queued ?? 0)}</td>
                  <td>{c.running ?? 0}</td>
                  <td>{c.succeeded ?? 0}</td>
                  <td>{c.failed ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section aria-labelledby="j-title" className="stack">
        <div className="section-head">
          <h2 id="j-title">Jobs</h2>
          <div className="field" style={{ minWidth: "10rem" }}>
            <label htmlFor="job-status">Status</label>
            <select id="job-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              {["failed", "pending", "running", "succeeded", "cancelled"].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </div>
        {jobs.isError ? (
          <ErrorNotice error={jobs.error} onRetry={() => void jobs.refetch()} />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Type</th>
                  <th scope="col">Status</th>
                  <th scope="col">Attempts</th>
                  <th scope="col">Error code</th>
                  <th scope="col">Updated</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {jobs.data?.items.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted">
                      No {status} jobs.
                    </td>
                  </tr>
                )}
                {jobs.data?.items.map((j) => (
                  <tr key={j.id}>
                    <td>{j.type}</td>
                    <td>{j.status}</td>
                    <td>{j.attempts}</td>
                    <td>{j.errorCode ?? "–"}</td>
                    <td>{new Date(j.updatedAt).toLocaleString()}</td>
                    <td>
                      {j.status === "failed" && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() =>
                            retry.mutate(j.id, {
                              onSuccess: () => toast("Job queued for retry"),
                              onError: (e) => toast(errorText(e), "bad"),
                            })
                          }
                        >
                          Retry
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
