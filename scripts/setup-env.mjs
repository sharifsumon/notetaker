#!/usr/bin/env node
// Creates .env from .env.example with freshly generated local secrets.
// Usage: pnpm setup:env  (refuses to overwrite an existing .env)
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

if (existsSync(".env")) {
  console.error(".env already exists; not overwriting. Delete it first to regenerate.");
  process.exit(1);
}
let text = readFileSync(".env.example", "utf8");
const set = (key, value) => {
  text = text.replace(new RegExp(`^${key}=[^\\n#]*`, "m"), `${key}=${value}`);
};
set("SESSION_SECRET", randomBytes(36).toString("base64url"));
set("TOKEN_ENCRYPTION_KEYS", `k1:${randomBytes(32).toString("base64")}`);
set("MOCK_BOT_WEBHOOK_SECRET", randomBytes(24).toString("base64url"));
writeFileSync(".env", text, { mode: 0o600 });
console.log("Created .env with generated local secrets (development defaults, mock providers).");
