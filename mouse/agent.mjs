#!/usr/bin/env node
/**
 * Spring Mouse agent.
 *
 * Start the HTTP endpoint first, register with Spring, then keep heartbeating.
 * The callback URL must be reachable from Spring; provider traffic is forwarded
 * from Spring to this process with a Mouse execution token.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

const AGENT_VERSION = "1.0.0";
const DEFAULT_PORT = 9101;
const HEARTBEAT_INTERVAL_MS = 30_000;

function usage(code = 0) {
  const text = `Spring Mouse agent

Usage:
  node mouse/agent.mjs --spring-url http://spring:8008 --registration-token msr_... --callback-url http://mouse-host:9101

Options:
  --spring-url URL            Base URL of Spring (or SPRING_URL)
  --registration-token TOKEN  One-time registration token (or MOUSE_REGISTRATION_TOKEN)
  --callback-url URL          URL Spring uses to reach this agent (or MOUSE_CALLBACK_URL)
  --name NAME                 Mouse display name (or MOUSE_NAME)
  --host HOST                 HTTP bind address (default 0.0.0.0)
  --port PORT                 HTTP port (default 9101)
  --state-file PATH           Identity file (default ~/.spring-mouse-agent/agent.json)
  --reset                     Ignore the saved identity and register again
`;
  process.stdout.write(`${text}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage();
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    values[key] = value;
    i += 1;
  }
  return values;
}

function normalizeBaseUrl(value, label) {
  try {
    const url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("must use http or https");
    return url.toString().replace(/\/$/, "");
  } catch (error) {
    throw new Error(`Invalid ${label}: ${error.message}`);
  }
}

function statePath() {
  return process.env.MOUSE_STATE_FILE
    || path.join(os.homedir(), ".spring-mouse-agent", "agent.json");
}

function loadState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function hashValue(value) {
  return createHash("sha256").update(String(value)).digest();
}

function secureEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  return timingSafeEqual(hashValue(left), hashValue(right));
}

function bearerToken(request) {
  return request.headers.authorization?.replace(/^Bearer\s+/i, "").trim() || "";
}

function extractClientIp(request) {
  return request.socket.remoteAddress || null;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "content-length", "host",
]);

function forwardHeaders(source) {
  const headers = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) headers[key] = value;
  }
  return headers;
}

async function readJson(request, maxBytes = 128 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

class MouseAgent {
  constructor(options) {
    this.options = options;
    this.stateFile = options.stateFile;
    this.state = loadState(options.stateFile);
    this.startedAt = new Date().toISOString();
    this.heartbeatTimer = null;
    this.server = createServer((request, response) => this.handle(request, response));
  }

  get identity() {
    return this.state.identity || null;
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });

    if (!this.identity || this.options.reset) {
      await this.register();
    }

    console.log(`[mouse] callback ${this.options.callbackUrl}`);
    console.log(`[mouse] identity ${this.identity.mouseId} (${this.identity.name})`);
    await this.heartbeat();
    this.scheduleHeartbeat();
  }

  async register() {
    if (!this.options.springUrl || !this.options.registrationToken) {
      throw new Error("Mouse identity is missing; SPRING_URL and MOUSE_REGISTRATION_TOKEN are required");
    }
    const response = await fetch(`${this.options.springUrl}/api/mouses/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        registrationToken: this.options.registrationToken,
        name: this.options.name || os.hostname(),
        version: AGENT_VERSION,
        capabilities: ["http-provider-execute"],
        callbackUrl: this.options.callbackUrl,
        metadata: { startedAt: this.startedAt, pid: process.pid },
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Registration failed (${response.status})`);

    this.state = {
      version: 1,
      identity: {
        ...data.mouse,
        accessToken: data.accessToken,
        executionToken: data.executionToken,
      },
      registeredAt: new Date().toISOString(),
    };
    saveState(this.stateFile, this.state);
    console.log("[mouse] registration complete");
  }

  scheduleHeartbeat() {
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeat()
        .catch((error) => console.error(`[mouse] heartbeat failed: ${error.message}`))
        .finally(() => this.scheduleHeartbeat());
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  async heartbeat() {
    const response = await fetch(`${this.options.springUrl}/api/mouses/heartbeat`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.identity.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: AGENT_VERSION,
        capabilities: ["http-provider-execute"],
        metadata: {
          callbackUrl: this.options.callbackUrl,
          startedAt: this.startedAt,
          pid: process.pid,
          uptimeSeconds: Math.round(process.uptime()),
        },
      }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${response.status}`);
    }
  }

  async execute(task, request, response) {
    const upstreamRequest = task.request || {};
    const target = new URL(upstreamRequest.url || "");
    if (!["http:", "https:"].includes(target.protocol)) throw Object.assign(new Error("invalid target URL"), { status: 400 });
    if (upstreamRequest.method !== "POST" || typeof upstreamRequest.body !== "string") {
      throw Object.assign(new Error("only POST requests with a JSON string body are supported"), { status: 400 });
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort(new Error("client disconnected"));
    request.on("close", onAbort);
    const timeout = this.options.timeoutMs > 0
      ? setTimeout(() => controller.abort(new Error("provider timeout")), this.options.timeoutMs)
      : null;

    try {
      const providerResponse = await fetch(target, {
        method: "POST",
        headers: forwardHeaders(upstreamRequest.headers),
        body: upstreamRequest.body,
        signal: controller.signal,
      });
      response.writeHead(providerResponse.status, forwardHeaders(Object.fromEntries(providerResponse.headers)));
      if (request.aborted || response.writableEnded) {
        providerResponse.body?.cancel?.();
        return;
      }
      await Readable.fromWeb(providerResponse.body).pipe(response);
    } finally {
      clearTimeout(timeout);
      request.off("close", onAbort);
    }
  }

  async handle(request, response) {
    const pathname = new URL(request.url, "http://localhost").pathname;
    try {
      if (pathname === "/healthz") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          ok: true,
          version: AGENT_VERSION,
          mouseId: this.identity?.mouseId || null,
          startedAt: this.startedAt,
        }));
        return;
      }

      if (pathname !== "/v1/execute" || request.method !== "POST") {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "not found" }));
        return;
      }

      if (!this.identity?.executionToken || !secureEqual(bearerToken(request), this.identity.executionToken)) {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "invalid execution token" }));
        return;
      }

      const task = await readJson(request);
      const taskId = typeof task.taskId === "string" ? task.taskId : randomUUID();
      response.setHeader("X-Mouse-Task-Id", taskId);
      await this.execute(task, request, response);
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(error.status || 502, { "Content-Type": "application/json" });
      }
      if (!response.writableEnded) response.end(JSON.stringify({ error: error.message }));
      console.error(`[mouse] task failed: ${error.message}`);
    }
  }

  async stop() {
    clearTimeout(this.heartbeatTimer);
    await delay(0);
    this.server.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const host = args.host || process.env.MOUSE_HOST || "0.0.0.0";
  const port = Number(args.port || process.env.MOUSE_PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
  const callbackHost = ["0.0.0.0", "::"].includes(host) ? os.hostname() : host;
  const callbackUrl = normalizeBaseUrl(
    args["callback-url"] || process.env.MOUSE_CALLBACK_URL || `http://${callbackHost}:${port}`,
    "callback URL",
  );

  const agent = new MouseAgent({
    springUrl: normalizeBaseUrl(args["spring-url"] || process.env.SPRING_URL, "Spring URL"),
    registrationToken: args["registration-token"] || process.env.MOUSE_REGISTRATION_TOKEN || "",
    name: args.name || process.env.MOUSE_NAME || "",
    callbackUrl,
    host,
    port,
    stateFile: args["state-file"] || statePath(),
    reset: args.reset === true || process.env.MOUSE_RESET === "true",
    timeoutMs: Number(process.env.MOUSE_PROVIDER_TIMEOUT_MS || 0),
  });

  process.on("SIGINT", () => { void agent.stop().finally(() => process.exit(0)); });
  process.on("SIGTERM", () => { void agent.stop().finally(() => process.exit(0)); });
  await agent.start();
}

main().catch((error) => {
  console.error(`[mouse] startup failed: ${error.message}`);
  process.exit(1);
});
