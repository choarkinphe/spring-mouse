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

# CI-friendly npm registry (override with --build-arg to use another mirror
# or the official registry: https://registry.npmjs.org)
ARG NPM_REGISTRY=https://registry.npmmirror.com

# CI-friendly apk repositories (Aliyun mirror; official CDN stalls from CN agents)
RUN sed -i 's#https://dl-cdn.alpinelinux.org#https://mirrors.aliyun.com#g' /etc/apk/repositories \
  && apk --no-cache upgrade

COPY package.json package-lock.json ./
# Do NOT use --omit=optional here: lightningcss / @next/swc ship their native
# platform binaries as optionalDependencies, and Tailwind 4's CSS build
# fails without them. Using npm ci for reproducible builds.
RUN npm ci --registry=${NPM_REGISTRY}

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

# Build provenance consumed by the Jenkins deploy script (docker exec cat).
RUN printf '{"revision":"%s"}\n' "${APP_BUILD_VERSION}" > /app/build-info.json

RUN mkdir -p /app/data && chown -R node:node /app && \
  mkdir -p /app/data-home && chown node:node /app/data-home && \
  ln -sf /app/data-home /root/.spring-mouse 2>/dev/null || true

# Fix permissions at runtime (handles mounted volumes)
RUN sed -i 's#https://dl-cdn.alpinelinux.org#https://mirrors.aliyun.com#g' /etc/apk/repositories \
  && apk --no-cache upgrade && apk --no-cache add su-exec && \
  printf '#!/bin/sh\nchown -R node:node /app/data /app/data-home 2>/dev/null\nexec su-exec node "$@"\n' > /entrypoint.sh && \
  chmod +x /entrypoint.sh

EXPOSE 8008

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "custom-server.js"]
