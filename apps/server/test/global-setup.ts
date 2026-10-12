import pg from "pg";
import type { TestProject } from "vitest/node";
import { runMigrations } from "../src/db/migrate";

/**
 * Creates a fresh database per test run, applies migrations as the owner, and creates a
 * NON-superuser login role in `notetaker_app` so row-level security is genuinely enforced.
 * Requires TEST_DATABASE_ADMIN_URL (defaults to a local postgres superuser).
 */
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";
const APP_ROLE = "notetaker_test_app";
const APP_PASSWORD = "test-only-password";

export default async function setup(project: TestProject) {
  const dbName = `notetaker_test_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const owner = new URL(ADMIN_URL);
  owner.pathname = `/${dbName}`;
  await runMigrations(owner.toString());
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
      CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}' IN ROLE notetaker_app;
    END IF; END $$;`);
  await admin.end();

  const app = new URL(owner.toString());
  app.username = APP_ROLE;
  app.password = APP_PASSWORD;
  project.provide("dbOwnerUrl", owner.toString());
  project.provide("dbAppUrl", app.toString());

  return async () => {
    const c = new pg.Client({ connectionString: ADMIN_URL });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await c.end();
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    dbOwnerUrl: string;
    dbAppUrl: string;
  }
}
