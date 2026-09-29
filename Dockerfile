# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22-alpine
# Keep cloudflared inside the application image so the managed Cloudflare
# tunnel works in Docker without host-level installation. This is an official,
# multi-architecture image; deployments can override CLOUDFLARED_IMAGE at build time.
ARG CLOUDFLARED_IMAGE=cloudflare/cloudflared:latest

FROM ${CLOUDFLARED_IMAGE} AS cloudflared

# Litestream — the single static Go binary that replicates the SQLite database
# off-host (see src/lib/backup/). Downloaded per-architecture and verified
# against the release checksums: this process holds the backup credentials, so a
# tampered download would be a straight path to exfiltrating the whole database.
# The version and both hashes are pinned; bumping them is a deliberate act.
ARG LITESTREAM_VERSION=0.5.17
FROM ${NODE_IMAGE} AS litestream
ARG LITESTREAM_VERSION
ARG TARGETARCH
RUN apk --no-cache add curl && \
    case "${TARGETARCH}" in \
      amd64) ls_arch=x86_64; \
             ls_sha=cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d ;; \
      arm64) ls_arch=arm64; \
             ls_sha=f8ca4a050095c1efbda2c4365172e61bf9d955ea0d9ac42f448b52e51819baa5 ;; \
      *) echo "litestream: unsupported TARGETARCH '${TARGETARCH}'" >&2; exit 1 ;; \
    esac && \
    curl -fsSL -o /tmp/litestream.tar.gz \
      "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-${ls_arch}.tar.gz" && \
    echo "${ls_sha}  /tmp/litestream.tar.gz" | sha256sum -c - && \
    tar -xzf /tmp/litestream.tar.gz -C /usr/local/bin litestream && \
    chmod +x /usr/local/bin/litestream && \
    rm -f /tmp/litestream.tar.gz && \
    /usr/local/bin/litestream version

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

# Copy package files - prefer package-lock.json for reproducible builds
COPY package.json package-lock.json* ./
# Use npm ci if package-lock.json exists, otherwise fallback to npm install
RUN --mount=type=cache,target=/root/.npm,id=spring-mouse-npm-${TARGETARCH} \
    npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    npm config set fetch-timeout 300000 && \
    if [ -f package-lock.json ]; then \
      if [ "${NPM_REGISTRY%/}" != "https://registry.npmjs.org" ]; then \
        sed -i "s#https://registry.npmjs.org/#${NPM_REGISTRY%/}/#g" package-lock.json; \
      fi; \
      timeout 20m npm ci --foreground-scripts --prefer-offline --no-audit --no-fund --registry=${NPM_REGISTRY}; \
    else \
      echo "Warning: package-lock.json not found, using npm install instead"; \
      timeout 20m npm install --foreground-scripts --prefer-offline --no-audit --no-fund --registry=${NPM_REGISTRY}; \
    fi

COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

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

# Build provenance consumed by the Jenkins deploy script (docker exec cat).
RUN printf '{"revision":"%s"}\n' "${APP_BUILD_VERSION}" > /app/build-info.json

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
