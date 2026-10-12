#!/usr/bin/env node
// Creates .env from .env.example with freshly generated secrets.
//   Local development:  node scripts/setup-env.mjs
//   Production server:  node scripts/setup-env.mjs --production notes.example.com you@example.com
// Refuses to overwrite an existing .env.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

if (existsSync(".env")) {
  console.error(".env already exists; not overwriting. Delete it first to regenerate.");
  process.exit(1);
}
const args = process.argv.slice(2);
const production = args[0] === "--production";
let text = readFileSync(".env.example", "utf8");
const set = (key, value) => {
  const re = new RegExp(`^${key}=[^\\n#]*`, "m");
  text = re.test(text) ? text.replace(re, `${key}=${value} `) : `${text}\n${key}=${value}\n`;
};
const hex = (n) => randomBytes(n).toString("hex");

set("SESSION_SECRET", randomBytes(36).toString("base64url"));
set("TOKEN_ENCRYPTION_KEYS", `k1:${randomBytes(32).toString("base64")}`);

if (production) {
  const [, domain, email] = args;
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) || !email || !email.includes("@")) {
    console.error(
      "Usage: node scripts/setup-env.mjs --production <domain> <email-for-https-certificates>",
    );
    process.exit(1);
  }
  set("NODE_ENV", "production");
  set("PUBLIC_URL", `https://${domain}`);
  set("WEBHOOK_PUBLIC_URL", `https://${domain}`);
  set("COOKIE_SECURE", "true");
  set("AUTH_DEV_LOGIN_ENABLED", "false");
  // Mock providers are refused in production. Configure real ones in .env (docs/PROVIDERS.md).
  set("MEETING_BOT_PROVIDER", "none");
  set("STT_PROVIDER", "none");
  set("LLM_PROVIDER", "none");
  set("MOCK_BOT_WEBHOOK_SECRET", "");
  set("METRICS_TOKEN", hex(24));
  text += [
    "",
    "# ---- docker-compose.prod.yml (single-server deployment) ----",
    `DOMAIN=${domain}`,
    `ACME_EMAIL=${email}`,
    `POSTGRES_PASSWORD=${hex(24)}`,
    `APP_DB_PASSWORD=${hex(24)}`,
    `REDIS_PASSWORD=${hex(24)}`,
    "",
  ].join("\n");
} else {
  set("MOCK_BOT_WEBHOOK_SECRET", randomBytes(24).toString("base64url"));
}

writeFileSync(".env", text, { mode: 0o600 });
console.log(
  production
    ? "Created production .env. Add your Google/Microsoft and provider credentials before starting."
    : "Created .env with generated local secrets (development defaults, mock providers).",
);
