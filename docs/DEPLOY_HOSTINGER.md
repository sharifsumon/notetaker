# Deploying to a Hostinger VPS

This app needs PostgreSQL, Redis, ffmpeg and a background worker, so it must run on a
**Hostinger VPS**. Hostinger's Web and Cloud hosting plans can run some Node.js apps, but they do
not support PostgreSQL. The setup below runs everything on one VPS with Docker Compose and
automatic HTTPS (Caddy + Let's Encrypt).

## What you need

- A Hostinger VPS with **at least 4 GB RAM** (building the images needs memory), using the
  **Ubuntu with Docker** template (or plain Ubuntu, then install Docker).
- A domain or subdomain you control, e.g. `notes.example.com`.
- For sign-in: a Google and/or Microsoft OAuth app (see `PROVIDERS.md` §1–2), with redirect URIs on
  your domain.

## 1. Point your domain at the VPS

In your DNS (Hostinger hPanel → Domains → DNS, or wherever the domain is managed) add an **A record**
for `notes` (or `@`) pointing to the VPS IP address shown in hPanel → VPS. Wait until
`ping notes.example.com` resolves to that IP. Caddy cannot get a certificate before this works.

## 2. Prepare the server

```bash
ssh root@YOUR_VPS_IP
# If you did not use the Docker template:
curl -fsSL https://get.docker.com | sh

# Firewall: SSH + web only (Postgres/Redis are never exposed)
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable

# Node.js is only needed to run the env setup script
apt-get update && apt-get install -y nodejs git
```

If you also use the firewall in hPanel (VPS → Security → Firewall), allow ports 22, 80 and 443 there
too.

## 3. Get the code onto the server

Either push the repository to a private GitHub repo and clone it:

```bash
git clone https://github.com/YOU/meeting-notetaker.git /opt/notetaker
```

or upload the zip from your computer and unzip it:

```bash
scp meeting-notetaker.zip root@YOUR_VPS_IP:/opt/
ssh root@YOUR_VPS_IP "cd /opt && apt-get install -y unzip && unzip meeting-notetaker.zip && mv meeting-notetaker notetaker"
```

## 4. Create the production configuration

```bash
cd /opt/notetaker
node scripts/setup-env.mjs --production notes.example.com you@example.com
nano .env
```

The script generates all secrets and database/Redis passwords and sets production-safe values
(`NODE_ENV=production`, HTTPS URLs, secure cookies, dev login off). In `.env`, add:

- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and/or `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET`
  (redirect URIs: `https://notes.example.com/api/v1/auth/google/callback` and
  `https://notes.example.com/api/v1/calendar-connections/google_calendar/callback`; the Microsoft
  equivalents end in `/microsoft/callback` and `/microsoft_calendar/callback`).
- Optional now, needed later: `LLM_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`,
  `STT_PROVIDER=deepgram` + `DEEPGRAM_API_KEY`.
- `RETENTION_DAYS` once you have decided the retention policy.

Keep `.env` private (`chmod 600 .env`, never commit it) and store a copy of it in a password manager:
losing `TOKEN_ENCRYPTION_KEYS` makes stored calendar tokens unreadable.

## 5. Start it

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps        # all services "running"/"healthy", migrate "exited (0)"
docker compose -f docker-compose.prod.yml logs -f caddy api worker
```

The first build takes several minutes. Then open `https://notes.example.com`, sign in, and grant
yourself the operations role:

```bash
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U notetaker_owner -d notetaker -c "select id, email from users"
docker compose -f docker-compose.prod.yml run --rm api node dist/grant-admin.js <USER_ID>
```

## What works on a fresh production deployment

- Sign-in, calendar connection and sync, the dashboard, meeting list and settings.
- **Recording does not work yet**: no meeting-bot provider is configured
  (`MEETING_BOT_PROVIDER=none`), so "Record" returns "Meeting recording provider is not configured".
  The development mock is deliberately refused in production. Choose a provider and add its adapter
  first (`PROVIDERS.md` §3), then set `MEETING_BOT_PROVIDER`.
- The bot provider will call `https://notes.example.com/api/v1/webhooks/meeting-provider/<name>`.

## Updating

```bash
cd /opt/notetaker
git pull                       # or upload and unzip the new version
docker compose -f docker-compose.prod.yml up -d --build   # migrate runs automatically before api/worker
```

## Backups

1. Turn on Hostinger's VPS backups / snapshots in hPanel (whole-server copies).
2. Also take a daily database dump that you copy off the server:

```bash
mkdir -p /opt/backups
cat > /etc/cron.daily/notetaker-backup <<'EOF'
#!/bin/sh
cd /opt/notetaker
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U notetaker_owner -d notetaker -Fc > /opt/backups/notetaker-$(date +%F).dump
find /opt/backups -name 'notetaker-*.dump' -mtime +14 -delete
EOF
chmod +x /etc/cron.daily/notetaker-backup
```

Recordings live in the `notetaker_storage` Docker volume; include
`/var/lib/docker/volumes/notetaker_storage` in your backups. Restore a dump with
`pg_restore -U notetaker_owner -d notetaker --clean <file>` inside the postgres container, then
restart `api` and `worker`.

## Troubleshooting

| Symptom                            | Check                                                                                                                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser shows a certificate error  | DNS A record not pointing at the VPS yet, or ports 80/443 blocked. `docker compose … logs caddy`                                                                           |
| `api` keeps restarting             | `docker compose … logs api` — the first lines list every invalid setting in `.env`                                                                                         |
| `migrate` failed                   | `docker compose … logs migrate`; the database volume may have been created before `.env` existed — remove it only if it holds no data: `docker volume rm notetaker_pgdata` |
| "redirect_uri_mismatch" on sign-in | the redirect URIs in Google/Microsoft must match `PUBLIC_URL` exactly (https, no trailing slash)                                                                           |
| Build killed / out of memory       | use a VPS with more RAM, or add swap: `fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`                                           |
