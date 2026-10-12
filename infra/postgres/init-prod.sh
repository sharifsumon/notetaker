#!/bin/sh
# Runs once, when the PostgreSQL volume is first created.
# Creates the runtime login role (not a superuser, not the table owner) so row-level
# security is enforced. APP_DB_PASSWORD must be alphanumeric (setup-env generates hex).
set -eu
case "$APP_DB_PASSWORD" in
  *[!A-Za-z0-9]*) echo "APP_DB_PASSWORD must be alphanumeric" >&2; exit 1 ;;
esac
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<EOSQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'notetaker_app') THEN
    CREATE ROLE notetaker_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'notetaker_api') THEN
    CREATE ROLE notetaker_api LOGIN PASSWORD '$APP_DB_PASSWORD' IN ROLE notetaker_app;
  END IF;
END
\$\$;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
EOSQL
