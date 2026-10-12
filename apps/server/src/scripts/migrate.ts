import { runMigrations } from "../db/migrate";

const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_MIGRATION_URL or DATABASE_URL must be set");
  process.exit(1);
}
runMigrations(url)
  .then(() => {
    console.log("Migrations applied");
  })
  .catch((err: unknown) => {
    console.error("Migration failed", err);
    process.exit(1);
  });
