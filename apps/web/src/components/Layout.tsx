import type { Me } from "@notetaker/shared";
import { CalendarClock, LayoutDashboard, LogOut, Settings, Activity, List } from "lucide-react";
import { NavLink, Outlet } from "react-router";
import { useSignOut } from "../lib/queries";

export function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="6" fill="var(--signal)" />
      <path
        d="M9 9h14M9 14h14M9 19h9"
        stroke="var(--signal-ink)"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <circle cx="23" cy="22" r="3.2" fill="var(--highlight)" />
    </svg>
  );
}

export function Layout({ me }: { me: Me }) {
  const signOut = useSignOut();
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      {me.features.mockProviders && (
        <div className="mock-banner" role="note">
          Development mode: recordings, transcripts and notes come from mock providers, not real
          meetings.
        </div>
      )}
      <div className="shell">
        <aside className="sidebar">
          <NavLink to="/" className="brand" end>
            <Logo />
            Notetaker
          </NavLink>
          <nav className="nav" aria-label="Main">
            <NavLink to="/" end>
              <LayoutDashboard size={18} aria-hidden="true" />
              Dashboard
            </NavLink>
            <NavLink to="/meetings">
              <List size={18} aria-hidden="true" />
              Meetings
            </NavLink>
            <NavLink to="/settings">
              <Settings size={18} aria-hidden="true" />
              Settings
            </NavLink>
            {me.role === "admin" && (
              <NavLink to="/admin">
                <Activity size={18} aria-hidden="true" />
                Operations
              </NavLink>
            )}
          </nav>
          <div className="sidebar-foot">
            <span className="who">
              <CalendarClock size={14} aria-hidden="true" /> {me.displayName}
              <br />
              <span className="muted">Times in {me.timezone}</span>
            </span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => signOut.mutate(false)}
              disabled={signOut.isPending}
            >
              <LogOut size={16} aria-hidden="true" />
              Sign out
            </button>
          </div>
        </aside>
        <main className="main" id="main" tabIndex={-1}>
          <Outlet context={me} />
        </main>
      </div>
    </>
  );
}
