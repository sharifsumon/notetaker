# syntax=docker/dockerfile:1.7
# API and worker image (same image, different command). Build context: repository root.
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN pnpm --filter @notetaker/server build \
 && pnpm --filter @notetaker/server deploy --prod --legacy /out \
 && cp -r apps/server/dist apps/server/drizzle /out/

FROM ${NODE_IMAGE} AS runtime
# ffmpeg/ffprobe are required for audio validation and normalization.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    MIGRATIONS_DIR=/app/drizzle \
    STORAGE_LOCAL_DIR=/data/storage
WORKDIR /app
COPY --from=build --chown=node:node /out /app
RUN mkdir -p /data/storage && chown -R node:node /data
USER node
EXPOSE 4000
ENTRYPOINT ["/usr/bin/tini", "--"]
# Override with `node dist/main-worker.js` for the worker, `node dist/migrate.js` for migrations.
CMD ["node", "dist/main-api.js"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/v1/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
