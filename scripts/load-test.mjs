#!/usr/bin/env node

/**
 * Small dependency-free concurrency probe for a Spring Mouse OpenAI endpoint.
 * It intentionally requires an explicit API key and model because it sends real
 * upstream requests that can consume provider quota.
 */

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    args[key] = value && !value.startsWith("--") ? value : true;
    if (args[key] !== true) index += 1;
  }
  return args;
}

function percentile(values, p) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.round((ordered.length - 1) * p))];
}

function summary(values) {
  if (!values.length) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    minMs: Math.round(Math.min(...values)),
    p50Ms: Math.round(percentile(values, 0.5)),
    p95Ms: Math.round(percentile(values, 0.95)),
    maxMs: Math.round(Math.max(...values)),
    avgMs: Math.round(total / values.length),
  };
}

async function consume(response) {
  if (!response.body) return { firstByteMs: null, bytes: 0 };
  const reader = response.body.getReader();
  let bytes = 0;
  let firstByteAt = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstByteAt === null) firstByteAt = performance.now();
    bytes += value?.byteLength || 0;
  }
  return { firstByteAt, bytes };
}

const args = parseArgs(process.argv.slice(2));
const baseUrl = String(args["base-url"] || "").replace(/\/$/, "");
const apiKey = String(args["api-key"] || process.env.SPRING_MOUSE_LOAD_TEST_API_KEY || "");
const model = String(args.model || "");
const concurrency = Math.max(1, Number.parseInt(args.concurrency || "1", 10) || 1);
const requests = Math.max(concurrency, Number.parseInt(args.requests || String(concurrency), 10) || concurrency);
const timeoutMs = Math.max(1000, Number.parseInt(args["timeout-ms"] || "180000", 10) || 180000);
const endpoint = String(args.endpoint || "/v1/chat/completions");

if (!baseUrl || !apiKey || !model) {
  console.error("Usage: node scripts/load-test.mjs --base-url https://gateway.example --api-key sm-... --model provider/model [--concurrency 1 --requests 20]");
  console.error("The probe sends real requests and consumes provider quota.");
  process.exit(2);
}

const target = `${baseUrl}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
const results = [];
let nextRequest = 0;

async function runOne(index) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("load-test timeout"), timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(target, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
      }),
      signal: controller.signal,
    });
    const headersAt = performance.now();
    const consumed = await consume(response);
    const completedAt = performance.now();
    return {
      index,
      ok: response.ok,
      status: response.status,
      headersMs: headersAt - startedAt,
      firstByteMs: consumed.firstByteAt === null ? null : consumed.firstByteAt - startedAt,
      totalMs: completedAt - startedAt,
      bytes: consumed.bytes,
      error: null,
    };
  } catch (error) {
    return {
      index,
      ok: false,
      status: 0,
      headersMs: null,
      firstByteMs: null,
      totalMs: performance.now() - startedAt,
      bytes: 0,
      error: error?.message || String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function worker() {
  while (true) {
    const index = nextRequest;
    nextRequest += 1;
    if (index >= requests) return;
    results.push(await runOne(index));
  }
}

console.log(JSON.stringify({ target, model, concurrency, requests, timeoutMs, startedAt: new Date().toISOString() }));
await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, worker));

const ok = results.filter((result) => result.ok);
const failed = results.filter((result) => !result.ok);
const report = {
  target,
  model,
  concurrency,
  requests,
  successes: ok.length,
  failures: failed.length,
  statusCounts: Object.fromEntries([...new Set(results.map((result) => result.status))].map((status) => [status, results.filter((result) => result.status === status).length])),
  headers: summary(ok.map((result) => result.headersMs).filter(Number.isFinite)),
  firstByte: summary(ok.map((result) => result.firstByteMs).filter(Number.isFinite)),
  total: summary(ok.map((result) => result.totalMs).filter(Number.isFinite)),
  failuresSample: failed.slice(0, 10).map(({ index, status, error, totalMs }) => ({ index, status, error, totalMs: Math.round(totalMs) })),
};
console.log(JSON.stringify(report, null, 2));
process.exitCode = failed.length ? 1 : 0;
