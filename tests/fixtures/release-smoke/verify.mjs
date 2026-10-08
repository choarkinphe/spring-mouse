import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

const base = process.env.SMOKE_URL || "http://127.0.0.1:8038";
const control = process.env.SMOKE_CONTROL_URL || "http://127.0.0.1:8039";
const password = process.env.SMOKE_PASSWORD;
assert.ok(password, "SMOKE_PASSWORD required; never use production credentials");
let cookie = "";
const api = async (pathname, body, method = body ? "POST" : "GET") => {
  const response = await fetch(base + pathname, {
    method, headers: { "content-type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000),
  });
  assert.ok(response.ok, `${pathname}: HTTP ${response.status}`);
  return response;
};
const health = await (await api("/api/health")).json(); assert.equal(health.ok, true);
const login = await api("/api/auth/login", { password });
cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; "); assert.ok(cookie, "login cookie missing");
const key = await (await api("/api/keys", { name: "isolated-release-smoke" })).json();
const headers = { "content-type": "application/json", Authorization: `Bearer ${key.key}` };
const unsigned = await fetch(base + "/v1/models"); assert.equal(unsigned.status, 401);
const models = await fetch(base + "/v1/models", { headers }); assert.equal(models.status, 200);
const connections = [];
for (const provider of ["qianwen", "qianwen-token-plan"]) {
  const result = await (await api("/api/providers", { provider, name: `${provider} fixture`, apiKey: "fixture-not-real" })).json();
  connections.push(result.connection);
  const test = await (await api(`/api/providers/${result.connection.id}/test`, {})).json(); assert.equal(test.valid, true);
  const listed = await (await api(`/api/providers/${result.connection.id}/models`)).json(); assert.ok(listed.models.some((m) => m.id === "qwen3.8-flash"));
  await api("/api/providers/model-sync", { providerId: provider, supportedModels: listed.models });
}
// Verify tag filtering rather than just unrestricted successful routing.
await api("/api/settings", { modelAccessTags: { "qianwen/qwen3.8-flash": ["release-fixture"] } }, "PATCH");
const tagDenied = await fetch(base + "/v1/chat/completions", { method: "POST", headers, body: JSON.stringify({ model: "qianwen/qwen3.8-flash", stream: false, messages: [{ role: "user", content: "fixture tag" }] }) });
assert.ok(tagDenied.status >= 400 && tagDenied.status < 500, "missing tag did not reject request");
await tagDenied.text();
await api(`/api/keys/${key.id}`, { accessTags: ["release-fixture"] }, "PUT");
const matrix = [];
for (const provider of ["qianwen", "qianwen-token-plan"]) {
  for (const [endpoint, body] of [
    ["chat/completions", { messages: [{ role: "user", content: "fixture ping" }] }],
    ["responses", { input: "fixture ping" }],
    ["messages", { messages: [{ role: "user", content: "fixture ping" }], max_tokens: 100 }],
  ]) {
    for (const stream of [false, true]) {
      const response = await fetch(base + "/v1/" + endpoint, { method: "POST", headers, body: JSON.stringify({ model: `${provider}/qwen3.8-flash`, stream, ...body }), signal: AbortSignal.timeout(20000) });
      assert.equal(response.status, 200); const text = await response.text(); assert.ok(text.includes("fixture ok"));
      if (stream) assert.ok(/\[DONE\]|response.completed|message_stop/.test(text), "terminal event missing");
      matrix.push({ provider, endpoint, stream, status: response.status });
    }
  }
  const vision = await fetch(base + "/v1/responses", { method: "POST", headers, body: JSON.stringify({ model: `${provider}/qwen3.8-flash`, stream: false, input: [{ role: "user", content: [{ type: "input_text", text: "fixture image" }, { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMfoAAAAASUVORK5CYII=" }] }] }), signal: AbortSignal.timeout(20000) });
  assert.equal(vision.status, 200); await vision.text();
}
// Exercise the built gateway's per-connection proxy route, not a fetch mock.
// Exclude any connections left by an earlier fixture run so the proxy account
// cannot be silently skipped by account selection.
const existing = await (await api("/api/providers")).json();
for (const connection of existing.connections) {
  if (connection.provider === "qianwen" && connection.id !== connections[0].id) await api(`/api/providers/${connection.id}`, { isActive: false }, "PUT");
}
await api(`/api/providers/${connections[0].id}`, { providerSpecificData: { connectionProxyEnabled: true, connectionProxyUrl: "http://upstream:8080", connectionNoProxy: "" }, connectionProxyEnabled: true, connectionProxyUrl: "http://upstream:8080" }, "PUT");
const proxyBefore = (await (await fetch(control)).json()).proxyConnects;
const cancellation = [];
for (const stage of ["headers", "first-chunk", "midstream", "body"]) {
  const before = await (await fetch(control)).json();
  const abort = new AbortController();
  const pending = (async () => {
    const response = await fetch(base + "/v1/chat/completions", { method: "POST", headers, body: JSON.stringify({ model: "qianwen/qwen3.8-flash", stream: stage !== "body", messages: [{ role: "user", content: "smoke-stage-" + stage }] }), signal: abort.signal });
    await response.text();
  })();
  const settled = pending.then(() => "unexpected-success", () => "cancelled");
  let entered = false;
  for (let i = 0; i < 100; i++) {
    const metrics = await (await fetch(control)).json();
    if (metrics.records.length > before.records.length && metrics.active > 0) { entered = true; break; }
    await sleep(50);
  }
  assert.ok(entered, `stage ${stage} not entered`); abort.abort(); assert.equal(await settled, "cancelled");
  let cleaned = false;
  for (let i = 0; i < 100; i++) { if ((await (await fetch(control)).json()).active === 0) { cleaned = true; break; } await sleep(50); }
  assert.ok(cleaned, `stage ${stage} retained upstream work`);
  cancellation.push({ stage, cancelled: true });
}
const concurrent = Array.from({ length: 5 }, () => new AbortController());
const beforeConcurrent = (await (await fetch(control)).json()).records.length;
const stalled = concurrent.map((abort) => fetch(base + "/v1/chat/completions", { method: "POST", headers, body: JSON.stringify({ model: "qianwen/qwen3.8-flash", stream: false, messages: [{ role: "user", content: "smoke-stage-headers" }] }), signal: abort.signal }).then((r) => r.text()).then(() => "unexpected-success", () => "cancelled"));
let allEntered = false;
for (let i = 0; i < 150; i++) {
  const metrics = await (await fetch(control)).json();
  if (metrics.records.length >= beforeConcurrent + concurrent.length) { allEntered = true; break; }
  await sleep(50);
}
assert.ok(allEntered, "concurrent gateway requests did not reach upstream");
concurrent.forEach((abort) => abort.abort());
assert.deepEqual(await Promise.all(stalled), concurrent.map(() => "cancelled"));
for (let i = 0; i < 100; i++) { if ((await (await fetch(control)).json()).active === 0) break; await sleep(50); }
assert.equal((await (await fetch(control)).json()).active, 0, "concurrent gateway work retained");
const afterCancel = await fetch(base + "/v1/chat/completions", { method: "POST", headers, body: JSON.stringify({ model: "qianwen/qwen3.8-flash", stream: false, messages: [{ role: "user", content: "fixture healthy" }] }), signal: AbortSignal.timeout(20000) });
assert.equal(afterCancel.status, 200); await afterCancel.text();
const proxyAfter = (await (await fetch(control)).json()).proxyConnects;
assert.ok(proxyAfter > proxyBefore, "proxy path fell back to direct; CONNECT was never observed");
await api("/api/combos", { name: "release-fixture-fallback", models: ["qianwen/qwen3.8-flash", "qianwen-token-plan/qwen3.8-flash"], kind: "llm" });
const fallback = await fetch(base + "/v1/chat/completions", { method: "POST", headers, body: JSON.stringify({ model: "release-fixture-fallback", stream: false, messages: [{ role: "user", content: "smoke-stage-fallback" }] }), signal: AbortSignal.timeout(30000) });
assert.equal(fallback.status, 200); await fallback.text();
// Credentials never enter the report. Fixture traffic records retain only labels.
console.log(JSON.stringify({ ok: true, version: await (await api("/api/version")).json(), matrix, cancellation, connectionIds: connections.map((c) => c.id), realUpstreamVerified: false }));
