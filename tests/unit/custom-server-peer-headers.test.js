// custom-server.js is the only thing that makes x-sm-real-ip trustworthy. Boot a real
// HTTP server through it and confirm a client cannot smuggle its own peer headers in.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import http from "node:http";
import { __test__ as requestDetails } from "@/lib/db/repos/requestDetailsRepo.js";

const require = createRequire(import.meta.url);

let server;
let readinessServer;
let readinessStatus = 200;
let baseUrl;
let seenHeaders;

beforeAll(async () => {
  readinessServer = http.createServer((req, res) => {
    res.statusCode = req.url === "/ready" ? readinessStatus : 404;
    res.end();
  });
  await new Promise((resolve) => readinessServer.listen(0, "127.0.0.1", resolve));
  process.env.CLOUDFLARED_METRICS_PORT = String(readinessServer.address().port);
  process.env.CLOUDFLARED_READINESS_CACHE_MS = "0";
  require("../../custom-server.js");
  server = http.createServer((req, res) => {
    seenHeaders = req.headers;
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => readinessServer.close(resolve));
  delete process.env.CLOUDFLARED_METRICS_PORT;
  delete process.env.CLOUDFLARED_READINESS_CACHE_MS;
});

async function get(headers = {}) {
  await fetch(baseUrl, { headers });
  return seenHeaders;
}

describe("custom-server peer header sanitizing", () => {
  it("generates a peer trust token at boot", () => {
    expect(process.env.SPRING_MOUSE_PEER_TOKEN).toMatch(/^[0-9a-f]{48}$/);
  });

  it("replaces a client-supplied x-sm-real-ip with the socket address", async () => {
    const headers = await get({ "x-sm-real-ip": "203.0.113.55" });

    expect(headers["x-sm-real-ip"]).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
  });

  it("stamps the trust token so downstream can tell the wrapper ran", async () => {
    const headers = await get();

    expect(headers["x-sm-peer-token"]).toBe(process.env.SPRING_MOUSE_PEER_TOKEN);
  });

  it("drops a client-supplied peer trust token", async () => {
    const headers = await get({ "x-sm-peer-token": "forged-token" });

    expect(headers["x-sm-peer-token"]).toBe(process.env.SPRING_MOUSE_PEER_TOKEN);
    expect(headers["x-sm-peer-token"]).not.toBe("forged-token");
  });

  it("drops a client-supplied x-sm-via-proxy marker", async () => {
    const headers = await get({ "x-sm-via-proxy": "1" });

    expect(headers["x-sm-via-proxy"]).toBeUndefined();
  });

  it("marks via-proxy and adopts the forwarded IP for a loopback proxy hop", async () => {
    const headers = await get({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" });

    expect(headers["x-sm-via-proxy"]).toBe("1");
    expect(headers["x-sm-real-ip"]).toBe("203.0.113.9");
    expect(headers["x-forwarded-for"]).toBeUndefined();
  });

  it("uses Cloudflare's visitor IP only while the tunnel is connected", async () => {
    readinessStatus = 200;
    const headers = await get({
      "cf-connecting-ip": "198.51.100.24",
      "x-forwarded-for": "198.51.100.24",
    });

    expect(headers["x-sm-via-proxy"]).toBe("1");
    expect(headers["x-sm-real-ip"]).toBe("198.51.100.24");
  });

  it("ignores every forwarded IP header while the tunnel is disconnected", async () => {
    readinessStatus = 503;
    const headers = await get({
      "cf-connecting-ip": "198.51.100.24",
      "x-forwarded-for": "198.51.100.24",
      "x-real-ip": "198.51.100.24",
    });

    expect(headers["x-sm-via-proxy"]).toBeUndefined();
    expect(headers["x-sm-real-ip"]).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
  });

  it("uses Cloudflare's preserved IPv6 after the tunnel reconnects", async () => {
    readinessStatus = 200;
    const headers = await get({
      "cf-connecting-ip": "240.0.0.1",
      "cf-connecting-ipv6": "2001:db8::24",
    });

    expect(headers["x-sm-real-ip"]).toBe("2001:db8::24");
  });

  it("preserves X-Real-IP precedence for non-Cloudflare proxies", async () => {
    const headers = await get({
      "x-forwarded-for": "198.51.100.25, 192.0.2.10",
      "x-real-ip": "198.51.100.25",
    });

    expect(headers["x-sm-real-ip"]).toBe("198.51.100.25");
  });

  // chat.js snapshots every client header into the request detail. Anything that grants
  // access must not survive into a record the dashboard renders and cloud sync uploads.
  it("keeps the peer token out of persisted request details", () => {
    const sanitized = requestDetails.sanitizeHeaders({
      "x-sm-peer-token": "secret",
      "x-9r-cli-token": "secret",
      "authorization": "Bearer sk-x",
      "x-sm-real-ip": "127.0.0.1",
    });

    expect(sanitized["x-sm-peer-token"]).toBeUndefined();
    expect(sanitized["x-9r-cli-token"]).toBeUndefined();
    expect(sanitized["authorization"]).toBeUndefined();
    expect(sanitized["x-sm-real-ip"]).toBe("127.0.0.1");
  });
});
