import { useNavigate, useOutletContext } from "react-router";
import type { Me } from "@notetaker/shared";
import { CalendarConnections } from "../components/CalendarConnections";
import { RecordingPreferences } from "../components/RecordingSettings";

/** First-time setup (BRD 5.1): calendar connection and recording behaviour are explicit steps. */
export function OnboardingPage() {
  const me = useOutletContext<Me>();
  const navigate = useNavigate();
  return (
    <div className="stack-lg" style={{ maxWidth: "48rem" }}>
      <div className="page-head">
        <div>
          <h1>Set up recording</h1>
          <p>Two steps: connect a calendar, then choose how recording should work. You can change both later in Settings.</p>
        </div>
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => {
            try {
              sessionStorage.setItem("onboarding-skipped", "1");
            } catch {
              /* storage unavailable */
            }
            navigate("/");
          }}
        >
          Skip for now
        </button>
      </div>
      <section className="panel" aria-labelledby="step-cal">
        <h2 id="step-cal">1. Connect a calendar</h2>
        <p className="muted small" style={{ marginBottom: "0.5rem" }}>
          Optional. Without a calendar you can still add meeting links by hand.
        </p>
        <CalendarConnections />
      </section>
      <section className="panel" aria-labelledby="step-rec">
        <h2 id="step-rec">2. Recording and consent</h2>
        <RecordingPreferences me={me} submitLabel="Finish setup" onDone={() => navigate("/")} />
      </section>
    </div>
  );
}
