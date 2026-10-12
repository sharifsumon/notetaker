-- Security migration: runtime role, privileges, row-level security, search index.
-- The application connects with a LOGIN role that is a member of `notetaker_app`
-- (never the table owner / a superuser), so RLS is enforced. See docs/ARCHITECTURE.md (ADR-004).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'notetaker_app') THEN
    CREATE ROLE notetaker_app NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO notetaker_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, auth_identities, sessions, calendar_connections, meetings, meeting_participants,
  recordings, transcripts, meeting_artifacts, meeting_status_events, webhook_events, jobs
TO notetaker_app;
--> statement-breakpoint
-- Audit log is append-only for the application.
GRANT SELECT, INSERT ON audit_events TO notetaker_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_rls_allows(owner uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.system', true), '') = 'on'
      OR owner = nullif(current_setting('app.user_id', true), '')::uuid
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_rls_allows(uuid) TO notetaker_app;
--> statement-breakpoint
ALTER TABLE calendar_connections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE calendar_connections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY calendar_connections_owner ON calendar_connections USING (app_rls_allows(user_id)) WITH CHECK (app_rls_allows(user_id));
--> statement-breakpoint
ALTER TABLE meetings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE meetings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY meetings_owner ON meetings USING (app_rls_allows(user_id)) WITH CHECK (app_rls_allows(user_id));
--> statement-breakpoint
ALTER TABLE meeting_participants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE meeting_participants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY meeting_participants_owner ON meeting_participants USING (app_rls_allows(user_id)) WITH CHECK (app_rls_allows(user_id));
--> statement-breakpoint
ALTER TABLE recordings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE recordings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY recordings_owner ON recordings USING (app_rls_allows(user_id)) WITH CHECK (app_rls_allows(user_id));
--> statement-breakpoint
ALTER TABLE transcripts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE transcripts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY transcripts_owner ON transcripts USING (app_rls_allows(user_id)) WITH CHECK (app_rls_allows(user_id));
--> statement-breakpoint
ALTER TABLE meeting_artifacts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE meeting_artifacts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY meeting_artifacts_owner ON meeting_artifacts USING (app_rls_allows(user_id)) WITH CHECK (app_rls_allows(user_id));
--> statement-breakpoint
ALTER TABLE meeting_status_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE meeting_status_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY meeting_status_events_owner ON meeting_status_events USING (app_rls_allows(user_id)) WITH CHECK (app_rls_allows(user_id));
--> statement-breakpoint
-- Child rows must belong to the same user as their meeting.
CREATE OR REPLACE FUNCTION app_check_child_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM meetings m WHERE m.id = NEW.meeting_id AND m.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'owner mismatch for %', TG_TABLE_NAME USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER meeting_participants_owner_chk BEFORE INSERT OR UPDATE ON meeting_participants FOR EACH ROW EXECUTE FUNCTION app_check_child_owner();
--> statement-breakpoint
CREATE TRIGGER recordings_owner_chk BEFORE INSERT OR UPDATE ON recordings FOR EACH ROW EXECUTE FUNCTION app_check_child_owner();
--> statement-breakpoint
CREATE TRIGGER transcripts_owner_chk BEFORE INSERT OR UPDATE ON transcripts FOR EACH ROW EXECUTE FUNCTION app_check_child_owner();
--> statement-breakpoint
CREATE TRIGGER meeting_artifacts_owner_chk BEFORE INSERT OR UPDATE ON meeting_artifacts FOR EACH ROW EXECUTE FUNCTION app_check_child_owner();
--> statement-breakpoint
CREATE TRIGGER meeting_status_events_owner_chk BEFORE INSERT OR UPDATE ON meeting_status_events FOR EACH ROW EXECUTE FUNCTION app_check_child_owner();
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS meetings_title_trgm_idx ON meetings USING gin (title gin_trgm_ops);
