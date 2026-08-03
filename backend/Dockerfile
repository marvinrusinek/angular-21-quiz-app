# Interview API — private quiz backend.
#
# This image holds the ANSWER KEY. It is never served as a static file and the
# quiz bank never reaches the browser: routes return metadata, active questions
# without correctness, and full review only after submission.
#
# Multi-stage so the runtime image carries no compiler, no dev dependencies and
# no TypeScript sources. Both stages share one base image because
# better-sqlite3 is a NATIVE module — binaries compiled against one libc will
# not load under another, so builder and runtime must match exactly.

# ── build ───────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build

# better-sqlite3 compiles from source; node-gyp needs python3, make and g++.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first: this layer is cached until the manifests change, so a
# source-only edit skips the native rebuild entirely.
COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# Re-resolve to production dependencies only. `npm ci --omit=dev` prunes the
# dev tree while KEEPING the already-compiled better-sqlite3 binary.
RUN npm ci --omit=dev

# ── runtime ─────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
# The app resolves its quiz bank and database relative to the working
# directory (process.cwd()), so this must stay /app.
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# The private quiz bank. Baked into the image rather than mounted: it is code,
# not user data, and it must never live under a static route.
COPY data/quiz.json ./data/quiz.json

# Sessions are written OUTSIDE the image — a redeploy replaces the container,
# and an in-image database would take every in-flight assessment with it.
#
# /tmp is the zero-cost default: always writable, no volume required. It is
# also EPHEMERAL, so sessions do not survive a restart. For durable sessions,
# mount a volume and override DATABASE_PATH (e.g. /data/sessions.db); the
# directory below is created ready for exactly that.
ENV DATABASE_PATH=/tmp/sessions.db
RUN mkdir -p /data && chown -R node:node /data

# Drop root. The process only needs to read /app and write /data.
USER node

EXPOSE 3000

# The app exits non-zero on a misconfiguration before it ever listens, so a
# failing health check here means the process is genuinely unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/server.js"]
