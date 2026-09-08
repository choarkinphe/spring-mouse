// Opt-in: real local HTTP, Redis, SQLite and /v1/responses handler. No model API
// calls or production credentials. Run SM_CONCURRENCY_BENCH=1 npm --prefix tests test -- performance/multi-window.test.js
import { describe, it, expect } from "vitest";
import http from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { monitorEventLoopDelay } from "node:perf_hooks";

const root = fileURLToPath(new URL("../../", import.meta.url));
const listen = async (server) => { server.listen(0, "127.0.0.1"); await once(server, "listening"); return server.address().port; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p) => Math.round((sorted[Math.ceil(sorted.length * p) - 1] || 0) * 100) / 100;
  return { count: sorted.length, p50Ms: q(.5), p95Ms: q(.95), maxMs: q(1) };
}

describe.skipIf(process.env.SM_CONCURRENCY_BENCH !== "1")("20 users with multiple Responses windows", () => {
  it("benchmarks 1/20/60/100 concurrent streams using an isolated local upstream", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "sm-concurrency-"));
    const env = { ...process.env };
    const children = []; const servers = [];
    let db, closeRedis, closeRoutingRedis, getSlots;
    const originalFetch = globalThis.fetch;
    let runningUpstream = 0, peakUpstream = 0;
    const delayMs = Number(process.env.SM_BENCH_DELAY_MS || 75);
    const durationMs = Number(process.env.SM_BENCH_STREAM_MS || 1200);
    const promptBytes = Number(process.env.SM_BENCH_PROMPT_BYTES || 32768);
    const eventLoop = monitorEventLoopDelay({resolution: 10});
    let redisPort;
    try {
      const probe = http.createServer(); servers.push(probe);
      redisPort = await listen(probe); await new Promise((r) => probe.close(r));
      const redis = spawn("redis-server", ["--bind", "127.0.0.1", "--port", String(redisPort), "--save", "", "--appendonly", "no", "--dir", temp], {stdio: ["ignore", "pipe", "pipe"]});
      children.push(redis);
      await new Promise((resolve, reject) => {
        let output = "";
        const timeout = setTimeout(() => reject(new Error(`Redis startup timeout: ${output}`)), 5000);
        redis.once("error", (e) => { clearTimeout(timeout); reject(e); });
        redis.once("exit", (c) => { clearTimeout(timeout); reject(new Error(`Redis exited ${c}: ${output}`)); });
        redis.stdout.on("data", (b) => { output += b; if (output.includes("Ready to accept connections")) { clearTimeout(timeout); resolve(); } });
        redis.stderr.on("data", (b) => { output += b; });
      });
      process.env.DATA_DIR = temp;
      process.env.SPRING_MOUSE_REDIS_URL = `redis://127.0.0.1:${redisPort}`;
      process.env.SPRING_MOUSE_REDIS_REQUIRED = "false";
      process.env.NODE_ENV = "production";
      process.env.LOG_LEVEL = "ERROR";
      for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete process.env[name];
      process.env.NO_PROXY = "127.0.0.1,localhost";
      const upstream = http.createServer(async (req, res) => {
        for await (const _ of req) { /* consume actual large prompt */ }
        if (req.url !== "/v1/responses") { res.writeHead(404).end(); return; }
        runningUpstream++; peakUpstream = Math.max(peakUpstream, runningUpstream);
        const id = `resp_${Math.random().toString(36).slice(2)}`;
        let interval, kickoff, ended = false;
        const cleanup = () => { if (ended) return; ended = true; clearInterval(interval); clearTimeout(kickoff); runningUpstream--; };
        res.on("close", cleanup);
        res.writeHead(200, {"content-type": "text/event-stream", "cache-control": "no-cache"});
        const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({type, ...data})}\n\n`);
        send("response.created", {response: {id, object: "response", status: "in_progress", output: []}});
        const text = "OK "; let chunks = 0;
        const count = Math.max(1, Math.floor(durationMs / 20));
        kickoff = setTimeout(() => {
          send("response.output_item.added", {output_index: 0, item: {id: "msg_test", type: "message", role: "assistant", content: []}});
          const tick = () => {
            if (ended) return;
            send("response.output_text.delta", {item_id: "msg_test", output_index: 0, content_index: 0, delta: text});
            if (++chunks >= count) {
              send("response.completed", {response: {id, object: "response", status: "completed", model: "bench-model", output: [{id: "msg_test", type: "message", role: "assistant", status: "completed", content: [{type: "output_text", text: text.repeat(count)}]}], usage: {input_tokens: 100, output_tokens: count, total_tokens: 100 + count}}});
              res.end(); cleanup();
            }
          };
          interval = setInterval(tick, 20); tick();
        }, delayMs);
      }); servers.push(upstream); const upstreamPort = await listen(upstream);
      const repo = await import("../../src/lib/localDb.js");
      const driver = await import("../../src/lib/db/driver.js"); db = await driver.getAdapter();
      ({closeRedisClient: closeRedis} = await import("../../src/lib/redis/client.js"));
      // A baseline checkout predates routingClient; benchmark accepts either tree.
      try { ({closeRoutingRedis} = await import("../../src/lib/redis/routingClient.js")); } catch {}
      try { ({getLocalSlotStatus: getSlots} = await import("../../src/lib/redis/connectionSlots.js")); } catch {}
      const provider = "openai-compatible-responses-concurrency";
      await repo.updateSettings({requireApiKey: true, enableObservability: false, rtkEnabled: false, headroomEnabled: false, pxpipeEnabled: false, providerStrategies: {[provider]: {fallbackStrategy: "round-robin"}}});
      await repo.createProviderNode({id: provider, type: "openai-compatible", name: "bench", prefix: "bench", apiType: "responses", baseUrl: `http://127.0.0.1:${upstreamPort}/v1`});
      for (let i = 0; i < 8; i++) await repo.createProviderConnection({provider, authType: "apikey", name: `account-${i}`, apiKey: `fake-upstream-${i}`, priority: i + 1, providerSpecificData: {apiType: "responses", baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, maxConcurrentStreams: 8}});
      const keys = [];
      for (let i = 0; i < 20; i++) keys.push((await repo.createApiKey(`user-${i}`, `bench-${i}`)).key);
      const writer = spawn(process.execPath, [path.join(root, "runtime/usage-writer.mjs")], {env: process.env, stdio: ["ignore", "ignore", "pipe"]}); children.push(writer);
      const { POST } = await import("../../src/app/api/v1/responses/route.js");
      const gateway = http.createServer(async (req, res) => {
        const abort = new AbortController();
        res.on("close", () => { if (!res.writableEnded) abort.abort(); });
        try {
          if (req.url === "/ping") { res.end("OK"); return; }
          const request = new Request("http://localhost/v1/responses", {method: "POST", headers: req.headers, body: Readable.toWeb(req), duplex: "half", signal: abort.signal});
          const response = await POST(request);
          res.writeHead(response.status, Object.fromEntries(response.headers));
          Readable.fromWeb(response.body).on("error", () => res.destroy()).pipe(res);
        } catch (e) { res.writeHead(500).end(String(e)); }
      }); servers.push(gateway); const gatewayPort = await listen(gateway);
      // The client uses Node's unpatched fetch; no outbound proxy or external API.
      async function one(index, direct = false) {
        const body = JSON.stringify({model: direct ? "bench-model" : "bench/bench-model", input: [{role: "user", content: "Reply OK. " + "x".repeat(promptBytes)}], stream: true});
        const start = performance.now();
        const response = await originalFetch(`http://127.0.0.1:${direct ? upstreamPort : gatewayPort}/v1/responses`, {method: "POST", headers: {Authorization: `Bearer ${keys[index % 20]}`, "content-type": "application/json", "content-length": String(Buffer.byteLength(body))}, body, signal: AbortSignal.timeout(15000)});
        const headersMs = performance.now() - start;
        let firstDeltaMs = null, terminal = false, error = false, buffer = "";
        const decoder = new TextDecoder();
        for await (const bytes of response.body) {
          buffer += decoder.decode(bytes, {stream: true});
          let end;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data:")) continue;
              try {
                const event = JSON.parse(line.slice(5));
                if (event.type === "response.output_text.delta" && event.delta && firstDeltaMs === null) firstDeltaMs = performance.now() - start;
                if (event.type === "response.completed") terminal = event.response?.status === "completed";
                if (event.type === "error" || event.type === "response.failed") error = true;
              } catch {}
            }
          }
        }
        return {ok: response.ok && terminal && !error && firstDeltaMs !== null, status: response.status, headersMs, firstDeltaMs, totalMs: performance.now() - start};
      }
      await one(0); // warm translation registry / DB / Redis / HTTP pool
      eventLoop.enable();
      const report = {node: process.version, cpus: os.cpus().length, model: "local simulated Responses", users: 20, promptBytes, simulatedFirstDeltaDelayMs: delayMs, simulatedStreamMs: durationMs, includes: "HTTP adapter + production POST/auth/routing/translation/Redis/SQLite/usage writer; excludes Next server, TLS and real model", rounds: []};
      for (const concurrency of [1, 20, 60, 100]) {
        for (const direct of [true, false]) {
          peakUpstream = 0; eventLoop.reset();
          const cpuStart = process.cpuUsage(); const start = performance.now();
          const requests = [];
          // Three waves per level; 60 = 20 users × 3 windows, 100 = × 5.
          for (let round = 0; round < 3; round++) requests.push(...await Promise.all(Array.from({length: concurrency}, (_, i) => one(i, direct))));
          const cpu = process.cpuUsage(cpuStart);
          await sleep(50);
          const row = {path: direct ? "direct" : "gateway", concurrency, requests: requests.length, failures: requests.filter((r) => !r.ok).length,
            headers: summary(requests.map((r) => r.headersMs)), ttft: summary(requests.map((r) => r.firstDeltaMs).filter((n) => n !== null)), total: summary(requests.map((r) => r.totalMs)), peakUpstream,
            eventLoopP95Ms: Math.round(eventLoop.percentile(95) / 1e4) / 100, cpuMs: (cpu.user + cpu.system) / 1000, elapsedMs: performance.now() - start, rssMiB: process.memoryUsage().rss / 1024 / 1024,
            activeLeasesAfter: getSlots?.().active ?? null};
          report.rounds.push(row); console.log("BENCH", JSON.stringify(row));
          expect(row.failures).toBe(0);
          if (getSlots) expect(row.activeLeasesAfter).toBe(0);
          expect(peakUpstream).toBe(concurrency);
        }
      }
      const output = process.env.SM_BENCH_OUTPUT || path.join(temp, "report.json");
      await fs.writeFile(output, JSON.stringify(report, null, 2));
      console.log(`BENCH_REPORT=${output}`);
    } finally {
      eventLoop.disable();
      for (const server of servers) { server.closeAllConnections?.(); if (server.listening) await new Promise((r) => server.close(r)); }
      closeRoutingRedis?.(); await closeRedis?.();
      for (const child of children.reverse()) { if (child.exitCode === null) { const done = once(child, "exit"); child.kill("SIGTERM"); await Promise.race([done, sleep(2000)]); if (child.exitCode === null) child.kill("SIGKILL"); } }
      db?.close(); globalThis.fetch = originalFetch;
      for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
      Object.assign(process.env, env);
      // Keep the temporary fixture/report available for inspection; never touches real data.
    }
  }, 180000);
});
