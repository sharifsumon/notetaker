import type { Me } from "@notetaker/shared";
import { useEffect } from "react";
import { useOutletContext, useSearchParams } from "react-router";
import { CalendarConnections } from "../components/CalendarConnections";
import { RecordingPreferences } from "../components/RecordingSettings";
import { Notice } from "../components/ui";
import { useSignOut } from "../lib/queries";

const CALENDAR_RESULT: Record<string, { tone: "ok" | "bad"; text: string }> = {
  connected: { tone: "ok", text: "Calendar connected. Your meetings are syncing now." },
  denied: { tone: "bad", text: "Calendar access was not granted. Connect again and approve read access to continue." },
  invalid_state: { tone: "bad", text: "The connection link expired. Start the connection again." },
  calendar_no_refresh_token: { tone: "bad", text: "The provider didn't grant ongoing access. Try connecting again." },
  failed: { tone: "bad", text: "The calendar couldn't be connected. Try again." },
  not_configured: { tone: "bad", text: "This calendar provider isn't configured on the server." },
};

export function SettingsPage() {
  const me = useOutletContext<Me>();
  const [params, setParams] = useSearchParams();
  const signOut = useSignOut();
  const result = params.get("calendar");

  useEffect(() => {
    if (result) document.getElementById("calendars")?.scrollIntoView();
  }, [result]);

  return (
    <div className="stack-lg" style={{ maxWidth: "52rem" }}>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Calendars, recording behaviour, and your account.</p>
        </div>
      </div>

      <section className="panel" id="calendars" aria-labelledby="cal-title">
        <h2 id="cal-title">Calendars</h2>
        {result && (
          <div style={{ marginBottom: "1rem" }}>
            <Notice
              tone={CALENDAR_RESULT[result]?.tone ?? "bad"}
              actions={
                <button type="button" className="btn btn-sm" onClick={() => setParams({}, { replace: true })}>
                  Dismiss
                </button>
              }
            >
              {CALENDAR_RESULT[result]?.text ?? CALENDAR_RESULT.failed!.text}
            </Notice>
          </div>
        )}
        <CalendarConnections />
      </section>

      <section className="panel" aria-labelledby="rec-title">
        <h2 id="rec-title">Recording and consent</h2>
        <RecordingPreferences me={me} />
      </section>

      <section className="panel" aria-labelledby="acct-title">
        <h2 id="acct-title">Account</h2>
        <dl className="facts">
          <dt>Name</dt>
          <dd>{me.displayName}</dd>
          <dt>Email</dt>
          <dd>{me.email ?? "Not provided"}</dd>
          <dt>Sign-in methods</dt>
          <dd>{me.identities.map((i) => (i.provider === "dev" ? "Development" : i.provider === "google" ? "Google" : "Microsoft")).join(", ")}</dd>
        </dl>
        <div className="row" style={{ marginTop: "1rem" }}>
          <button type="button" className="btn" onClick={() => signOut.mutate(true)} disabled={signOut.isPending}>
            Sign out on all devices
          </button>
        </div>
      </section>

      <section className="panel" aria-labelledby="ret-title">
        <h2 id="ret-title">Data retention and deletion</h2>
        <div className="prose small">
          <p>
            Recordings, transcripts, summaries and minutes are kept for the retention period set by your administrator, then
            deleted automatically. You can delete any meeting and all of its data at any time from the meeting page.
          </p>
          <p>
            To delete your whole account, contact your administrator. Disconnecting a calendar deletes its stored access tokens
            immediately.
          </p>
        </div>
      </section>
    </div>
  );
}
