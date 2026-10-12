import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Logo } from "../components/Layout";
import { Notice } from "../components/ui";
import { api } from "../lib/api";
import { useAuthConfig } from "../lib/queries";

const LOGIN_ERRORS: Record<string, string> = {
  access_denied: "Sign-in was cancelled. Choose an account to continue.",
  invalid_state: "The sign-in link expired or was opened in another browser. Start again.",
  session_expired: "Your session expired. Sign in again to continue.",
  oauth_invalid_id_token: "We couldn't verify the sign-in response. Try again.",
  not_configured: "This sign-in method isn't set up on this server.",
};

function GoogleMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.3 5.7c4.3-4 7-9.8 7-17z" />
      <path fill="#FBBC05" d="M10.6 28.6c-.5-1.5-.8-3-.8-4.6s.3-3.1.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.3-5.7c-2 1.4-4.7 2.3-8.6 2.3-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z" />
    </svg>
  );
}

function MicrosoftMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#F25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  );
}

export function LoginPage() {
  const [params] = useSearchParams();
  const config = useAuthConfig();
  const err = params.get("error");
  const [email, setEmail] = useState("demo@example.com");
  const [devError, setDevError] = useState<string | null>(null);

  const devLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setDevError(null);
    try {
      await api("/auth/dev-login", { method: "POST", body: { email, displayName: email.split("@")[0] } });
      window.location.assign("/");
    } catch {
      setDevError("Development sign-in failed. Check that the API is running.");
    }
  };

  const none = config.data && !config.data.googleAuth && !config.data.microsoftAuth && !config.data.devLogin;

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="row">
          <Logo />
          <strong style={{ fontSize: "var(--step-1)" }}>Notetaker</strong>
        </div>
        <div className="stack">
          <h1>Sign in</h1>
          <p className="lede">
            Record your Google Meet and Microsoft Teams meetings, then get a summary and formal minutes you can copy in one click.
          </p>
        </div>
        {err && <Notice tone="bad">{LOGIN_ERRORS[err] ?? "Sign-in failed. Try again."}</Notice>}
        <div className="auth-buttons">
          {config.data?.googleAuth && (
            <a className="btn" href="/api/v1/auth/google">
              <GoogleMark />
              Continue with Google
            </a>
          )}
          {config.data?.microsoftAuth && (
            <a className="btn" href="/api/v1/auth/microsoft">
              <MicrosoftMark />
              Continue with Microsoft
            </a>
          )}
          {none && (
            <Notice tone="wait" title="No sign-in method is configured">
              Set GOOGLE_CLIENT_ID / MICROSOFT_CLIENT_ID on the server. See the README.
            </Notice>
          )}
        </div>
        {config.data?.devLogin && (
          <form className="stack" onSubmit={devLogin} aria-labelledby="dev-login-title">
            <h2 id="dev-login-title" style={{ fontSize: "var(--step-0)" }}>
              Development sign-in
            </h2>
            <p className="small muted">Only available when the server runs with AUTH_DEV_LOGIN_ENABLED. Never enabled in production.</p>
            <div className="field">
              <label htmlFor="dev-email">Email</label>
              <input id="dev-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            {devError && <Notice tone="bad">{devError}</Notice>}
            <button type="submit" className="btn">
              Sign in as test user
            </button>
          </form>
        )}
        <p className="small muted">We never ask for your Google or Microsoft password. Calendar access is requested separately after sign-in.</p>
        <div className="auth-foot">
          <Link to="/privacy">Privacy notice</Link>
          <Link to="/privacy#recording">Recording policy</Link>
        </div>
      </div>
    </div>
  );
}
