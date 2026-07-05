# Self-contained SuperKuma image.
#
# Unlike docker/dockerfile (which depends on pre-published base images built by
# the CI pipeline), this builds everything from an official Node.js image in one
# `docker build .` — no prerequisites. It is the recommended image for
# deployment. Lean by design: it omits the optional heavy extras (Chromium for
# real-browser monitors, embedded MariaDB, cloudflared, apprise). External
# databases (MariaDB/MySQL/Postgres/etc.) and all other monitor/notification
# types work out of the box.

# ---- Build stage: install deps, compile native modules, build the frontend ----
FROM node:20-bookworm-slim AS build
WORKDIR /app

# Toolchain for native modules (e.g. @louislam/sqlite3).
RUN apt-get update && apt-get install --yes --no-install-recommends \
        python3 \
        build-essential \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Do not download Chromium during install (real-browser monitors are omitted).
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1

COPY .npmrc package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build \
    && npm prune --omit=dev \
    && mkdir -p ./data

# ---- Runtime stage ----
FROM node:20-bookworm-slim AS release
WORKDIR /app

LABEL org.opencontainers.image.source="https://github.com/alltomatos/superkuma"
LABEL org.opencontainers.image.title="SuperKuma"
LABEL org.opencontainers.image.description="Self-hosted monitoring with Master-Agent federation, multi-tenant RBAC and a built-in MCP server."

ENV NODE_ENV=production
ENV SUPERKUMA_IS_CONTAINER=1

# Runtime system dependencies:
#   iputils-ping  = ping monitors
#   ca-certificates = up-to-date TLS roots
#   dumb-init     = reap zombie processes (PID 1)
#   sqlite3       = debugging the embedded DB
#   curl, tzdata  = debugging / timezones
RUN apt-get update && apt-get install --yes --no-install-recommends \
        ca-certificates \
        iputils-ping \
        dumb-init \
        sqlite3 \
        curl \
        tzdata \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app /app

EXPOSE 3001
VOLUME [ "/app/data" ]

HEALTHCHECK --interval=60s --timeout=30s --start-period=180s --retries=5 \
    CMD node extra/healthcheck.js

ENTRYPOINT [ "/usr/bin/dumb-init", "--" ]
CMD [ "node", "server/server.js" ]
