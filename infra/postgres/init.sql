-- Local development only (docker compose). Creates the runtime login role used by the
-- API/worker. It is NOT a superuser and does not own the tables, so row-level security
-- applies. Migrations run as the owner (POSTGRES_USER).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'notetaker_app') THEN
    CREATE ROLE notetaker_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'notetaker_app_user') THEN
    CREATE ROLE notetaker_app_user LOGIN PASSWORD 'app_dev_password' IN ROLE notetaker_app;
  END IF;
END
$$;
