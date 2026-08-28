const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { pathToFileURL } = require("url");

const origCreate = http.createServer.bind(http);

// Per-process secret proving x-9r-real-ip was stamped below rather than sent by the client.
// A bare `next start` / `next dev` never loads this file, so it cannot produce a matching
// header even though the env var is inherited by child processes. Named like x-9r-cli-token
// so the request-detail header sanitizer redacts it too.
const PEER_TOKEN = crypto.randomBytes(24).toString("hex");
// Keep the legacy name while all request consumers migrate. Both values are
// process-local and therefore prove the internal header stamp equally.
process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
process.env.SPRING_MOUSE_PEER_TOKEN = PEER_TOKEN;

// Comma-separated allowlist of proxy peer IPs or IPv4 CIDRs. Loopback is
// always trusted so same-host proxies and cloudflared tunnels remain zero-config.
// Never trust forwarded client IP headers from an arbitrary public or private peer.
const TRUSTED_PROXY_IPS = (process.env.TRUSTED_PROXY_IPS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const configuredCloudflaredMetricsPort = Number.parseInt(process.env.CLOUDFLARED_METRICS_PORT || "20241", 10);
const CLOUDFLARED_METRICS_PORT = Number.isInteger(configuredCloudflaredMetricsPort)
  && configuredCloudflaredMetricsPort >= 1
  && configuredCloudflaredMetricsPort <= 65535
  ? configuredCloudflaredMetricsPort
  : 20241;
const CLOUDFLARED_READINESS_TIMEOUT_MS = 500;
const CLOUDFLARED_READINESS_CACHE_MS = Number.parseInt(
  process.env.CLOUDFLARED_READINESS_CACHE_MS || "5000",
  10,
);
let cloudflareReadiness = { connected: false, checkedAt: 0, promise: null };
let backgroundRefreshStarted = false;

function normalizeIp(ip) {
  const value = String(ip || "").trim().replace(/^\[|\]$/g, "");
  return value.startsWith("::ffff:") ? value.slice(7) : value;
}

function ipv4ToInt(ip) {
  const parts = normalizeIp(ip).split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value * 256) + octet;
  }
  return value >>> 0;
}

function matchesTrustedProxy(ip, rule) {
  const peer = normalizeIp(ip);
  const configured = normalizeIp(rule);
  if (peer === configured) return true;

  const [network, prefixText] = configured.split("/");
  if (!prefixText || configured.split("/").length !== 2) return false;
  const prefix = Number(prefixText);
  const peerValue = ipv4ToInt(peer);
  const networkValue = ipv4ToInt(network);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32 || peerValue === null || networkValue === null) return false;
  const mask = prefix === 0 ? 0 : ((0xFFFFFFFF << (32 - prefix)) >>> 0);
  return (peerValue & mask) === (networkValue & mask);
}

function isTrustedProxy(ip) {
  const peer = normalizeIp(ip);
  if (peer === "127.0.0.1" || peer === "::1") return true;
  return TRUSTED_PROXY_IPS.some((rule) => matchesTrustedProxy(peer, rule));
}

function isCloudflareTunnelConnected() {
  const now = Date.now();
  const cacheMs = Number.isFinite(CLOUDFLARED_READINESS_CACHE_MS)
    ? Math.max(0, CLOUDFLARED_READINESS_CACHE_MS)
    : 1000;
  if (cacheMs > 0 && now - cloudflareReadiness.checkedAt < cacheMs) {
    return Promise.resolve(cloudflareReadiness.connected);
  }
  if (cloudflareReadiness.promise) return cloudflareReadiness.promise;

  cloudflareReadiness.promise = new Promise((resolve) => {
    let settled = false;
    const finish = (connected) => {
      if (settled) return;
      settled = true;
      cloudflareReadiness.connected = connected;
      cloudflareReadiness.checkedAt = Date.now();
      cloudflareReadiness.promise = null;
      resolve(connected);
    };
    const readinessRequest = http.get({
      host: "127.0.0.1",
      port: CLOUDFLARED_METRICS_PORT,
      path: "/ready",
      timeout: CLOUDFLARED_READINESS_TIMEOUT_MS,
    }, (readinessResponse) => {
      const connected = readinessResponse.statusCode === 200;
      readinessResponse.resume();
      finish(connected);
    });
    readinessRequest.once("timeout", () => readinessRequest.destroy());
    readinessRequest.once("error", () => finish(false));
  });
  return cloudflareReadiness.promise;
}

function startBackgroundTokenRefreshFromCustomServer() {
  if (backgroundRefreshStarted) return;
  backgroundRefreshStarted = true;
  // Prefer source path (repo / standalone that still has src). Fail-open if missing
  // — initializeApp also starts the same scheduler when the Next app boots.
  const modPath = path.join(__dirname, "src", "sse", "services", "backgroundTokenRefresh.js");
  import(pathToFileURL(modPath).href)
    .then((m) => {
      try {
        m.startBackgroundTokenRefresh();
      } catch (e) {
        console.error("[BackgroundTokenRefresh] start failed:", e && e.message ? e.message : e);
      }
      const stop = () => {
        try {
          m.stopBackgroundTokenRefresh();
        } catch {
          /* ignore */
        }
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    })
    .catch((e) => {
      // Expected in published CLI standalone (src/ not on disk). App bootstrap covers it.
      if (process.env.DEBUG_BACKGROUND_TOKEN_REFRESH) {
        console.error("[BackgroundTokenRefresh] import failed:", e && e.message ? e.message : e);
      }
    });
}

// Wrap Next standalone HTTP server: derive client IP from the TCP socket
// (unspoofable) and strip client-supplied forwarding headers so downstream
// rate-limiting keys on the real peer address instead of attacker-controlled XFF.
http.createServer = (...args) => {
  const handler = args.find((a) => typeof a === "function");
  const rest = args.filter((a) => typeof a !== "function");
  if (!handler) return origCreate(...args);
  const wrapped = async (req, res) => {
    const socketIp = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
    const rawCfConnectingIpv6 = req.headers["cf-connecting-ipv6"];
    const rawCfConnectingIp = req.headers["cf-connecting-ip"];
    const hasCloudflareHeaders = !!(rawCfConnectingIpv6 || rawCfConnectingIp);
    const cloudflareConnected = hasCloudflareHeaders && await isCloudflareTunnelConnected();
    const cfConnectingIpv6 = cloudflareConnected ? rawCfConnectingIpv6 : "";
    const cfConnectingIp = cloudflareConnected ? rawCfConnectingIp : "";
    const xff = req.headers["x-forwarded-for"];
    const xRealIp = req.headers["x-real-ip"];
    const viaProxy = cloudflareConnected || (!hasCloudflareHeaders && !!(xff || xRealIp));
    const trustedProxy = isTrustedProxy(socketIp);
    // Cloudflare-shaped requests are all-or-nothing: when /ready is not healthy,
    // ignore every forwarded IP header and key the request by its TCP peer.
    const proxyIp = hasCloudflareHeaders
      ? (cfConnectingIpv6 || cfConnectingIp)
      : (xRealIp || (xff ? String(xff).split(",")[0].trim() : ""));
    const ip = trustedProxy && proxyIp ? proxyIp : socketIp;
    // Remove externally supplied peer markers before stamping trusted values.
    // Keep the x-9r aliases for older local clients while x-sm remains canonical.
    delete req.headers["x-sm-real-ip"];
    delete req.headers["x-sm-peer-token"];
    delete req.headers["x-sm-via-proxy"];
    delete req.headers["x-9r-real-ip"];
    delete req.headers["x-9r-peer-token"];
    delete req.headers["x-9r-via-proxy"];
    delete req.headers["x-forwarded-for"];

    req.headers["x-sm-real-ip"] = ip;
    req.headers["x-sm-peer-token"] = PEER_TOKEN;
    req.headers["x-9r-real-ip"] = ip;
    req.headers["x-9r-peer-token"] = PEER_TOKEN;
    if (viaProxy) {
      req.headers["x-sm-via-proxy"] = "1";
      req.headers["x-9r-via-proxy"] = "1";
    }
    return handler(req, res);
  };
  const server = origCreate(...rest, wrapped);
  server.once("listening", () => {
    startBackgroundTokenRefreshFromCustomServer();
  });
  const origEmit = server.emit;
  // JBR 25 sends h2c upgrades that the HTTP/1.1 server would otherwise close.
  server.emit = function (event, ...eventArgs) {
    const [req, socket, head] = eventArgs;
    if (event !== "upgrade" || String(req.headers.upgrade || "").toLowerCase() !== "h2c") {
      return origEmit.call(this, event, ...eventArgs);
    }

    const contentLength = Number(req.headers["content-length"] || 0);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      socket.destroy();
      return true;
    }
    const chunks = [head];
    let received = head.length;
    const serve = () => {
      // Replay the upgraded request through the existing HTTP/1.1 handler.
      const replay = new http.IncomingMessage(socket);
      Object.assign(replay, { method: req.method, url: req.url, headers: req.headers, complete: true });
      if (received) replay.push(Buffer.concat(chunks, received).subarray(0, contentLength));
      replay.push(null);
      const res = new http.ServerResponse(replay);
      res.shouldKeepAlive = false;
      res.assignSocket(socket);
      res.once("finish", () => socket.end());
      Promise.resolve().then(() => wrapped(replay, res)).catch((error) => {
        console.error("Failed to downgrade h2c request", error);
        socket.destroy();
      });
    };
    if (received >= contentLength) serve();
    else {
      socket.on("data", function readBody(chunk) {
        chunks.push(chunk);
        received += chunk.length;
        if (received < contentLength) return;
        socket.off("data", readBody);
        serve();
      });
      socket.resume();
    }
    delete req.headers.upgrade;
    delete req.headers["http2-settings"];
    req.headers.connection = "close";
    return true;
  };
  return server;
};

if (require.main === module) {
  // The wrapper is used in two layouts:
  // 1. beside server.js inside Docker / CLI standalone bundles;
  // 2. at the repository root after `next build`.
  // Always prefer the supported standalone server in either layout. Falling
  // through to `next start` with `output: "standalone"` is unsupported and can
  // serve a page whose RSC/chunk assets do not match the active build.
  const standalone = [
    path.join(__dirname, "server.js"),
    path.join(__dirname, ".next", "standalone", "server.js"),
  ].find((candidate) => fs.existsSync(candidate));

  if (standalone) {
    require(standalone);
  } else {
    // Keep a development-friendly fallback for checkouts that have not produced
    // a standalone build yet. Production builds should never take this branch.
    const nextBin = require.resolve("next/dist/bin/next");
    process.argv = [process.argv[0], nextBin, "start", ...process.argv.slice(2)];
    require(nextBin);
  }
}
