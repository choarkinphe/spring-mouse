# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22-alpine
# Keep cloudflared inside the application image so the managed Cloudflare
# tunnel works in Docker without host-level installation. This is an official,
# multi-architecture image; deployments can override CLOUDFLARED_IMAGE at build time.
ARG CLOUDFLARED_IMAGE=cloudflare/cloudflared:latest
# Litestream — the single static Go binary that replicates the SQLite database
# off-host (see src/lib/backup/). Taken from the official multi-arch image for
# the same reason as cloudflared: it is a published artifact, so the build needs
# no GitHub release download. (Downloading the release tarball from a CI runner
# failed with curl exit 22 — the release-asset host is not reachable from there —
# and a build that depends on reaching github.com is a build that breaks for
# reasons unrelated to this repo.) Override LITESTREAM_IMAGE to pin differently.
ARG LITESTREAM_IMAGE=litestream/litestream:0.5.17

FROM ${CLOUDFLARED_IMAGE} AS cloudflared
FROM ${LITESTREAM_IMAGE} AS litestream

FROM ${NODE_IMAGE} AS base
WORKDIR /app

# Injected by CI (git short hash). Used for image-label ↔ container ↔
# build-info version verification in the Jenkins deploy pipeline.
ARG APP_BUILD_VERSION=dev

FROM base AS builder
ARG APP_BUILD_VERSION=dev
ARG TARGETARCH

# Use the official npm registry by default. Deployments that need a private
# registry can still override this with --build-arg NPM_REGISTRY=... .
ARG NPM_REGISTRY=https://registry.npmmirror.com

# A missing lockfile is a build failure, never an implicit dependency upgrade.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,id=spring-mouse-npm-${TARGETARCH} \
    npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    npm config set fetch-timeout 300000 && \
    timeout 20m npm ci --foreground-scripts --prefer-offline --no-audit --no-fund --registry=${NPM_REGISTRY}

COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build && APP_BUILD_VERSION=${APP_BUILD_VERSION} node scripts/write-build-info.mjs /app

FROM ${NODE_IMAGE} AS runner
WORKDIR /app

ARG APP_BUILD_VERSION=dev
LABEL org.opencontainers.image.title="spring-mouse"
LABEL org.opencontainers.image.revision="${APP_BUILD_VERSION}"

ENV NODE_ENV=production
ENV PORT=8008
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/app/data
# Use the binary copied from the official Cloudflare image. This remains
# overrideable for custom deployments through CLOUDFLARED_BIN.
ENV CLOUDFLARED_BIN=/usr/local/bin/cloudflared

COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared
RUN /usr/local/bin/cloudflared --version

# Off-host database replication. Overrideable for custom deployments, matching
# the CLOUDFLARED_BIN convention above.
ENV LITESTREAM_BIN=/usr/local/bin/litestream
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
RUN /usr/local/bin/litestream version
# Tells the app that runtime/entrypoint.sh performs the boot-time restore swap.
# Without it the dashboard refuses to restore rather than exiting into a
# service that nothing would restart (see src/lib/backup/restore.js).
ENV SPRING_MOUSE_BOOT_RESTORE=1

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/custom-server.js ./custom-server.js
COPY --from=builder /app/open-sse ./open-sse
# Nodes download their runtime from /api/mouses/agent. That route reads the file
# with `fs`, which tracing cannot see, so carry it over explicitly.
COPY --from=builder /app/mouse ./mouse
# Next file tracing can omit sibling files; MITM runs server.js as a separate process.
COPY --from=builder /app/src/mitm ./src/mitm
# Standalone node_modules may omit deps only required by the MITM child process.
COPY --from=builder /app/node_modules/node-forge ./node_modules/node-forge
# Ensure `next` is available at runtime in case tracing did not include it.
COPY --from=builder /app/node_modules/next ./node_modules/next
# sql.js loads dist/sql-wasm.wasm by path at runtime; tracing only follows JS imports,
# so the last-resort DB driver would abort with ENOENT on the missing binary.
COPY --from=builder /app/node_modules/sql.js ./node_modules/sql.js
# The standalone tracer sees the web-side Redis client, but the SQLite writer
# is an external runtime script. Copy its client packages explicitly as well.
COPY --from=builder /app/node_modules/redis ./node_modules/redis
COPY --from=builder /app/node_modules/@redis ./node_modules/@redis
COPY --from=builder /app/node_modules/cluster-key-slot ./node_modules/cluster-key-slot
# proxyFetch dynamically imports ProxyAgent; standalone tracing may bundle only
# the web chunk, leaving raw runtime consumers without the dispatcher package.
COPY --from=builder /app/node_modules/undici ./node_modules/undici

# Preserve the dependency fingerprint from the same builder/lockfile.
COPY --from=builder /app/build-info.json ./build-info.json

RUN mkdir -p /app/data && chown -R node:node /app && \
  mkdir -p /app/data-home && chown node:node /app/data-home && \
  ln -sf /app/data-home /root/.spring-mouse 2>/dev/null || true

# Redis is embedded in the application container. It binds only to loopback;
# the existing /app/data mount persists its AOF beside SQLite.
RUN apk --no-cache upgrade && apk --no-cache add redis su-exec

COPY --from=builder /app/runtime ./runtime
COPY --from=builder /app/src/shared/utils/routingTelemetry.js ./src/shared/utils/routingTelemetry.js
RUN chmod +x /app/runtime/entrypoint.sh \
  && mkdir -p /app/data /app/data-home /app/data/redis \
  && chown -R node:node /app

EXPOSE 8008

ENTRYPOINT ["/app/runtime/entrypoint.sh"]
CMD ["node", "/app/runtime/docker-supervisor.mjs"]
