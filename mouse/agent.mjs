#!/usr/bin/env node
/**
 * Spring Mouse agent.
 *
 * The node dials Spring once and holds that stream open. Spring pushes tasks
 * down the connection it already has, and the agent answers on a second request
 * it makes itself. Both directions are outbound, so nothing here needs to be
 * reachable from Spring — which is what lets a node run behind NAT on a host
 * with no public address and no port mapping.
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const AGENT_VERSION = "2.1.0";
const DEFAULT_HEALTH_PORT = 9101;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const SSE_SEPARATOR = /\r?\n\r?\n/;

// Response headers that describe the transfer rather than the payload. The body
// seen here has already been decoded by fetch, so replaying the original
// content-encoding or content-length would make the receiver misread it.
const UNRELAYED_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host",
  "content-encoding", "content-length",
]);

function usage(code = 0) {
  const text = `Spring Mouse agent

Usage:
  node mouse/agent.mjs --spring-url http://spring:8008 --token mst_...

Options:
  --spring-url URL     Base URL of Spring (or SPRING_URL) — required
  --token TOKEN        Mouse access token from the dashboard (or MOUSE_TOKEN) — required
  --health-port PORT   Local healthcheck port (default ${DEFAULT_HEALTH_PORT})
  --once               Connect, serve until the tunnel drops, then exit
`;

  process.stdout.write(`${text}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage();
    if (arg === "--once") {
      values.once = true;
      continue;
    }
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

function relayableHeaders(source) {
  const headers = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (UNRELAYED_HEADERS.has(key.toLowerCase())) continue;
    if (typeof value !== "string") continue;
    headers[key] = value;
  }
  return headers;
}

function encodeHeaders(headers) {
  return Buffer.from(JSON.stringify(headers), "utf8").toString("base64");
}

/**
 * Minimal SSE reader. Frames are separated by a blank line and every field is
 * optional; the only two this agent understands are `event` and `data`.
 */
async function* readSseFrames(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let match = SSE_SEPARATOR.exec(buffer);
    while (match) {
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const parsed = parseSseFrame(frame);
      if (parsed) yield parsed;
      match = SSE_SEPARATOR.exec(buffer);
    }
  }
}

function parseSseFrame(raw) {
  let event = "message";
  const dataLines = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (!dataLines.length) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return { event, data: null };
  }
}

const MAX_ERROR_CHAIN = 5;

/**
 * Flattens an error and its `cause` chain into a single line.
 *
 * Node reports every network failure as the same bare `TypeError: fetch failed`,
 * which on its own says nothing about what went wrong — the errno and the real
 * message sit one or more `cause` levels down. Logging `error.message` alone threw
 * that away, so a DNS failure, a refused connection and a reset socket were
 * indistinguishable in the node's log. `AggregateError` is walked too, because
 * that is how a connect attempt that fails across several addresses is reported.
 */
function describeError(error) {
  const parts = [];
  const seen = new Set();

  const walk = (current, depth) => {
    if (!current || depth >= MAX_ERROR_CHAIN || parts.length >= MAX_ERROR_CHAIN) return;
    if (typeof current === "object") {
      if (seen.has(current)) return;
      seen.add(current);
    }
    const code = current.code || current.errno || "";
    const message = current.message || String(current);
    parts.push(code && !message.includes(String(code)) ? `${code} (${message})` : message);
    if (Array.isArray(current.errors) && current.errors.length) {
      for (const nested of current.errors) walk(nested, depth + 1);
      return;
    }
    walk(current.cause, depth + 1);
  };

  walk(error, 0);
  return parts.join(" <- ") || "unknown error";
}

class MouseAgent {
  constructor(options) {
    this.options = options;
    this.startedAt = new Date().toISOString();
    this.tunnelAbort = null;
    this.activeTasks = new Map();
    this.stopped = false;
    this.tunnelOpen = false;
    this.healthServer = createServer((request, response) => this.handleHealth(request, response));
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.healthServer.once("error", reject);
      this.healthServer.listen(this.options.healthPort, "127.0.0.1", () => {
        this.healthServer.off("error", reject);
        resolve();
      });
    });

    await this.tunnelLoop();
  }

  // The tunnel is the node's whole job, so a drop is normal and the loop simply
  // reconnects with a capped backoff. Spring treats a missing tunnel as an
  // offline node, so there is nothing to report while disconnected.
  async tunnelLoop() {
    let backoff = RECONNECT_MIN_MS;
    while (!this.stopped) {
      let connectedAt = 0;
      try {
        connectedAt = Date.now();
        await this.holdTunnel();
      } catch (error) {
        if (this.stopped) return;
        console.error(`[mouse] tunnel error: ${error.message}`);
      }
      if (this.stopped || this.options.once) return;

      // A tunnel that stayed up gets a fresh backoff: the reconnect is due to a
      // restart or a network blip, not to a rejection worth backing off from.
      if (connectedAt && Date.now() - connectedAt > RECONNECT_MIN_MS * 4) backoff = RECONNECT_MIN_MS;
      console.log(`[mouse] reconnecting in ${backoff}ms`);
      await delay(backoff);
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
    }
  }

  async holdTunnel() {
    const controller = new AbortController();
    this.tunnelAbort = controller;

    const url = new URL("/api/mouses/tunnel", this.options.springUrl);
    url.searchParams.set("version", AGENT_VERSION);

    console.log(`[mouse] connecting to ${url.origin}${url.pathname}`);
    const response = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${this.options.token}`,
        "Accept": "text/event-stream",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`rejected (${response.status}): ${text.slice(0, 200)}`);
    }
    if (!response.body) throw new Error("tunnel response had no body");

    this.tunnelOpen = true;
    console.log(`[mouse] tunnel open (v${AGENT_VERSION})`);

    try {
      for await (const frame of readSseFrames(response.body)) {
        if (frame.event === "task") {
          // Deliberately not awaited: one slow provider must not block the tasks
          // queued behind it on the same stream.
          void this.runTask(frame.data);
        } else if (frame.event === "cancel") {
          // A newer Spring names the reason; an older one sends none, so the bare
          // wording stays. Either way this text ends up on the task's failure line,
          // which is what tells an operator whether the node or the caller gave up.
          const cancelReason = typeof frame.data?.reason === "string" ? frame.data.reason : "";
          const cancelMessage = cancelReason
            ? `Spring cancelled the task (${cancelReason})`
            : "Spring cancelled the task";
          this.activeTasks.get(frame.data?.taskId)?.abort(new Error(cancelMessage));
        }
      }
    } finally {
      this.tunnelOpen = false;
      this.tunnelAbort = null;
      this.abortAllTasks("tunnel closed");
      console.log("[mouse] tunnel closed");
    }
  }

  abortAllTasks(reason) {
    for (const controller of this.activeTasks.values()) controller.abort(new Error(reason));
    this.activeTasks.clear();
  }

  resultUrl() {
    return new URL("/api/mouses/tunnel/result", this.options.springUrl);
  }

  /**
   * Tells Spring the task is in hand, before any provider call is made.
   *
   * This request deliberately carries no body. A request that carries one only
   * becomes readable to Spring once the whole upload has been buffered, so folding
   * this handshake into the result upload would silently make Spring's ack budget
   * cover the provider call too — and every request slower than that budget would be
   * killed even though the node was working normally.
   */
  async reportStarted(taskId) {
    let response;
    try {
      response = await fetch(this.resultUrl(), {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.options.token}`,
          "X-Mouse-Task-Id": taskId,
          "X-Mouse-Phase": "started",
        },
      });
      await response.arrayBuffer().catch(() => {});
    } catch (error) {
      // Swallowing this used to make a node that cannot reach Spring look exactly
      // like one that reported normally: Spring would still be sitting on its ack
      // budget while the node carried on to the provider.
      console.error(`[mouse] task ${taskId} could not report started: ${describeError(error)}`);
      return;
    }
    // A 404 is Spring saying it is no longer waiting on this task — the handshake
    // budget already expired, or the caller went away. The provider call that
    // follows is then work nobody will collect, and the result upload fails too.
    // It is only logged: the task is still attempted, because the reachability of
    // Spring must not silently change how the node behaves.
    if (!response.ok) {
      console.error(`[mouse] task ${taskId} started report rejected (HTTP ${response.status}); Spring is no longer waiting on this task`);
    }
  }

  /**
   * Runs one provider request and replays the answer to Spring: status and
   * headers as headers, the body as the upload. Spring can only start reading
   * once this request arrives, so a local failure is reported through the same
   * path instead of being left to time out.
   */
  async runTask(task) {
    const taskId = typeof task?.taskId === "string" ? task.taskId : randomUUID();
    const upstream = task?.request || {};
    const controller = new AbortController();
    this.activeTasks.set(taskId, controller);

    // Named so the failure line says which of the two outbound calls broke. Both are
    // `fetch`, both report the same bare "fetch failed", and they mean very different
    // things: one is the provider, the other is Spring itself.
    let stage = "handshake";

    try {
      // Announce the task before touching the network: this handshake is what Spring
      // stops its ack budget on, so it must not wait on the provider.
      await this.reportStarted(taskId);

      stage = "target-validation";
      const target = new URL(upstream.url || "");
      if (!["http:", "https:"].includes(target.protocol)) throw new Error("invalid target URL");
      if (upstream.method !== "POST" || typeof upstream.body !== "string") {
        throw new Error("only POST requests with a JSON string body are supported");
      }

      stage = "provider-fetch";
      const providerResponse = await fetch(target, {
        method: "POST",
        headers: relayableHeaders(upstream.headers),
        body: upstream.body,
        signal: controller.signal,
      });

      stage = "result-relay";
      const relay = await fetch(this.resultUrl(), {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.options.token}`,
          "X-Mouse-Task-Id": taskId,
          "X-Upstream-Status": String(providerResponse.status),
          "X-Upstream-Headers": encodeHeaders(relayableHeaders(Object.fromEntries(providerResponse.headers))),
          "Content-Type": "application/octet-stream",
        },
        body: providerResponse.body,
        duplex: "half",
        signal: controller.signal,
      });
      if (!relay.ok) {
        const text = await relay.text().catch(() => "");
        const upstreamStatus = providerResponse.status;
        // This status belongs to the Mouse → Spring result-upload request, not
        // necessarily to the provider request. Keep both statuses explicit so a
        // dashboard error cannot be mistaken for an upstream model failure.
        throw new Error(
          `Spring result relay rejected (${relay.status}); provider response was HTTP ${upstreamStatus}. `
          + `The failure is in the Mouse → Spring relay path. `
          + `Relay response: ${text.slice(0, 200)}`,
        );
      }
    } catch (error) {
      console.error(`[mouse] task ${taskId} failed during ${stage}: ${describeError(error)}`);
      await this.reportFailure(taskId, error, stage).catch((reportError) => {
        console.error(`[mouse] could not report task ${taskId}: ${describeError(reportError)}`);
      });
    } finally {
      this.activeTasks.delete(taskId);
    }
  }

  // Sent without the task's abort signal on purpose: the point of this call is
  // to unblock Spring, so a cancelled or already-failed task must still reach it.
  // The message carries the stage and the whole cause chain: Spring cannot read this
  // node's stderr, so what travels here is the only copy of the reason it will get.
  async reportFailure(taskId, error, stage = "") {
    const detail = describeError(error);
    const message = stage ? `Mouse task failed during ${stage}: ${detail}` : `Mouse task failed: ${detail}`;
    const body = JSON.stringify({ error: { message } });
    const response = await fetch(this.resultUrl(), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.options.token}`,
        "X-Mouse-Task-Id": taskId,
        "X-Upstream-Status": "502",
        "X-Upstream-Headers": encodeHeaders({ "content-type": "application/json" }),
        "Content-Type": "application/json",
      },
      body,
    });
    await response.arrayBuffer().catch(() => {});
  }

  handleHealth(request, response) {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname !== "/healthz") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    // Always 200 while the process runs: the container healthcheck is here to
    // catch a wedged process, and a dropped tunnel is recovered by the loop
    // rather than by restarting the container.
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      version: AGENT_VERSION,
      tunnel: this.tunnelOpen,
      activeTasks: this.activeTasks.size,
      startedAt: this.startedAt,
    }));
  }

  async stop() {
    this.stopped = true;
    this.tunnelAbort?.abort(new Error("agent shutting down"));
    this.abortAllTasks("agent shutting down");
    await delay(0);
    this.healthServer.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = args.token || process.env.MOUSE_TOKEN || "";
  if (!token) throw new Error("MOUSE_TOKEN or --token is required");
  const healthPort = Number(args["health-port"] || process.env.MOUSE_HEALTH_PORT || DEFAULT_HEALTH_PORT);
  if (!Number.isInteger(healthPort) || healthPort < 1 || healthPort > 65535) throw new Error("Invalid health port");

  const agent = new MouseAgent({
    springUrl: normalizeBaseUrl(args["spring-url"] || process.env.SPRING_URL, "Spring URL"),
    token,
    healthPort,
    once: args.once === true,
  });

  process.on("SIGINT", () => { void agent.stop().finally(() => process.exit(0)); });
  process.on("SIGTERM", () => { void agent.stop().finally(() => process.exit(0)); });
  await agent.start();
}

main().catch((error) => {
  console.error(`[mouse] startup failed: ${error.message}`);
  process.exit(1);
});
