// Isolated HTTP proof for the real Codex scanner; no DB or provider credentials.
import "../claude-desktop-smoke/register.mjs";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { CodexExecutor } from "../../../open-sse/executors/codex.js";

const port = Number(process.env.CODEX_FIXTURE_PORT || 8047);
const host = "127.0.0.1";
const type = "response.custom_tool_call_input.delta";
const frame = (event, extra = {}) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...extra })}\n\n`;
const preamble = frame("response.created", { response: { instructions: "fixture-not-for-logs" } });
const custom = frame(type, { delta: "fixture tool input" });
const tail = frame("response.custom_tool_call_input.done", { input: "fixture tool input" }) + frame("response.completed");
const overload = frame("error", { error: { code: "server_is_overloaded", message: "Our servers are currently overloaded. Please try again later." } });
const log = { errorLine(_prefix, _icon, message) { console.log(message); } };

async function verify() {
  const results = [];
  for (const scenario of ["healthy", "overload", "unknown"]) {
    const startedAt = Date.now();
    const response = await fetch(`http://${host}:${port}/upstream/${scenario}`, { signal: AbortSignal.timeout(10_000) });
    const scanned = await new CodexExecutor()._peekSseTransientError(response, scenario === "unknown" ? Date.now() + 100 : Infinity, log);
    const scanMs = Date.now() - startedAt;
    if (scenario === "healthy") {
      assert.equal(scanned.matched, null);
      assert.equal(scanned.stoppedOnDeadline, false);
      assert.ok(scanMs < 3_000, "custom input did not release before the upstream terminal frame");
      assert.equal(await new Response(scanned.replacementBody).text(), preamble + custom + tail);
      results.push({ scenario, status: 200, scanMs, streamBytesPreserved: true });
    } else if (scenario === "overload") {
      assert.equal(scanned.matched, "server_is_overloaded");
      assert.equal(scanned.replacementBody, null);
      results.push({ scenario, scanMs, overloadCaught: true });
    } else {
      assert.equal(scanned.stoppedOnDeadline, true);
      assert.equal(scanned.stopReason, "request");
      assert.equal(scanned.replacementBody, null);
      results.push({ scenario, scanMs, unknownNotPromoted: true });
    }
  }
  const report = { ok: true, check: "codex-custom-tool-http", realProviderCalled: false, results };
  console.log(JSON.stringify(report));
  return report;
}

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, `http://${host}:${port}`).pathname;
  if (path === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, fixture: "codex-custom-tool" }));
    return;
  }
  if (path.startsWith("/upstream/")) {
    const scenario = path.slice("/upstream/".length);
    const closed = once(res, "close");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(preamble);
    // Fragment the actual SSE event label across separate HTTP writes.
    const output = scenario === "unknown" ? frame("response.future.delta", { delta: "fixture unknown" }) : custom;
    res.write(output.slice(0, 30));
    await sleep(20);
    if (res.destroyed) return;
    res.write(output.slice(30));
    if (scenario === "overload") {
      await sleep(300);
      if (!res.destroyed) res.end(overload);
    } else if (scenario === "healthy") {
      await Promise.race([sleep(3_500), closed]);
      if (!res.destroyed) res.end(tail);
    } else {
      await closed;
    }
    return;
  }
  if (path === "/verify") {
    try {
      const report = await verify();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(report));
    } catch (error) {
      console.error("Codex fixture failed:", error.message);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }
  if (path === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end('<!doctype html><title>Codex scanner fixture</title><h1>Codex scanner HTTP verification</h1><p>Isolated fake upstream. No credentials or production data.</p><a href="/verify">Run verification</a>');
    return;
  }
  res.writeHead(404); res.end();
});
server.listen(port, host, async () => {
  assert.equal((await (await fetch(`http://${host}:${port}/api/health`)).json()).ok, true);
  console.log(`Codex fixture ready: http://${host}:${port}`);
});
server.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { server.close(); server.closeAllConnections(); });
