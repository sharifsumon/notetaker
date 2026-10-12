import { Link } from "react-router";

/**
 * Placeholder privacy notice and recording policy. The final text MUST be written and
 * approved by the product owner / legal counsel before launch (BRD 12, release gates).
 */
export function PrivacyPage() {
  return (
    <div className="auth" style={{ placeItems: "start center" }}>
      <article className="prose" style={{ maxWidth: "44rem" }}>
        <p>
          <Link to="/">Back to Notetaker</Link>
        </p>
        <h1>Privacy notice</h1>
        <p className="muted small">Draft for review. This text must be approved before public launch.</p>
        <h2>What we store</h2>
        <ul>
          <li>Your name, email and the identity provider you signed in with.</li>
          <li>Encrypted calendar access tokens, only if you connect a calendar.</li>
          <li>Meeting titles, times, links (encrypted) and participant names from your calendar or the recording provider.</li>
          <li>Audio recordings, transcripts, summaries and minutes for meetings you choose to record.</li>
        </ul>
        <h2>Who can see it</h2>
        <p>
          Only you. Administrators can see operational information such as job status and error codes, but not recordings,
          transcripts, summaries or minutes.
        </p>
        <h2 id="recording">Recording policy</h2>
        <ul>
          <li>A clearly named bot joins as a participant. It never bypasses lobbies, waiting rooms or host controls.</li>
          <li>You must inform participants and obtain any consent required in their jurisdiction before recording.</li>
          <li>Recordings are stored privately and are never published at a public link.</li>
        </ul>
        <h2>Retention and deletion</h2>
        <p>
          Data is deleted automatically after the configured retention period. You can delete any meeting and its data at any
          time.
        </p>
      </article>
    </div>
  );
}

export function NotFoundPage() {
  return (
    <div className="stack">
      <h1>Page not found</h1>
      <p className="muted">The address may be mistyped, or the page has moved.</p>
      <Link to="/">Go to the dashboard</Link>
    </div>
  );
}
