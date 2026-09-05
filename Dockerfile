# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22-alpine
# Keep cloudflared inside the application image so the managed Cloudflare
# tunnel works in Docker without host-level installation. This is an official,
# multi-architecture image; deployments can override CLOUDFLARED_IMAGE at build time.
ARG CLOUDFLARED_IMAGE=cloudflare/cloudflared:latest

FROM ${CLOUDFLARED_IMAGE} AS cloudflared

FROM ${NODE_IMAGE} AS base
WORKDIR /app

# Injected by CI (git short hash). Used for image-label ↔ container ↔
# build-info version verification in the Jenkins deploy pipeline.
ARG APP_BUILD_VERSION=dev

FROM base AS builder
ARG APP_BUILD_VERSION=dev

# Use the official npm registry by default. Deployments that need a private
# registry can still override this with --build-arg NPM_REGISTRY=... .
ARG NPM_REGISTRY=https://registry.npmjs.org

# Use the official Alpine CDN on hosted CI.
RUN apk --no-cache upgrade

# Copy package files - prefer package-lock.json for reproducible builds
COPY package.json package-lock.json* ./
# Use npm ci if package-lock.json exists, otherwise fallback to npm install
RUN if [ -f package-lock.json ]; then \
      npm ci --registry=${NPM_REGISTRY}; \
    else \
      echo "Warning: package-lock.json not found, using npm install instead"; \
      npm install --registry=${NPM_REGISTRY}; \
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

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/custom-server.js ./custom-server.js
COPY --from=builder /app/open-sse ./open-sse
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
RUN chmod +x /app/runtime/entrypoint.sh \
  && mkdir -p /app/data /app/data-home /app/data/redis \
  && chown -R node:node /app

EXPOSE 8008

ENTRYPOINT ["/app/runtime/entrypoint.sh"]
CMD ["node", "/app/runtime/docker-supervisor.mjs"]
