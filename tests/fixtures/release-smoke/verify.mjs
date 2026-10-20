import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { request as httpRequest } from "node:http";

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
  if (!response.ok) {
    // Sanitized locator for the public annotation: which dashboard API failed
    // and with which status. Never the response body or request payload.
    console.error(JSON.stringify({ event: "smoke.http.failure", endpoint: pathname, status: response.status }));
    await response.text().catch(() => {});
  }
  assert.ok(response.ok, `${pathname}: HTTP ${response.status}`);
  return response;
};
const health = await (await api("/api/health")).json(); assert.equal(health.ok, true);
// The upload deliberately never reaches EOF. Node Proxy body buffering used to
// prevent even the route's bearer check from running until the model finished.
// Run against the built, isolated image, with no real token or provider call.
await new Promise((resolve, reject) => {
  const request = httpRequest(new URL("/api/mouses/tunnel/result", base), {
    method: "POST", headers: { "content-type": "application/octet-stream" },
  });
  const timer = setTimeout(() => {
    request.destroy(new Error("Mouse upload was buffered before route authentication"));
  }, 5000);
  request.on("error", error => { clearTimeout(timer); reject(error); });
  request.on("response", response => {
    clearTimeout(timer);
    response.resume();
    try { assert.equal(response.statusCode, 401); resolve(); }
    catch (error) { reject(error); }
    finally { request.destroy(); }
  });
  request.write("synthetic partial upload\n");
});
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
  assert.equal(listed.discovery?.status, "success");
  assert.equal(listed.discovery?.source, "official");
  const synced = await (await api("/api/providers/model-sync", { providerId: provider, connectionId: result.connection.id })).json();
  assert.equal(synced.total, new Set(listed.models.map((model) => model.id)).size);
  assert.equal(synced.catalogCount, 0, "upstream-only sync expanded from public catalog");
  assert.equal(synced.staticCount, 0, "upstream-only sync expanded from registry seed");
  const stored = await (await api("/api/models/custom")).json();
  assert.equal(stored.snapshots[provider]?.source, "official");
  assert.equal(stored.snapshots[provider]?.connectionId, result.connection.id);
  assert.deepEqual([...stored.snapshots[provider].modelIds].sort(), listed.models.map((model) => model.id).sort());
  const catalog = await (await api("/api/models")).json();
  assert.deepEqual(catalog.models.filter((model) => model.provider === provider).map((model) => model.model).sort(), listed.models.map((model) => model.id).sort());
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
// Use the image's actual agent and gateway, with a synthetic account bound only
// inside this isolated database. The provider holds EOF until client cancellation.
const { MouseAgent } = await import("/app/mouse/agent.mjs");
const enrolled = await (await api("/api/mouses", { name: "release-mouse-fixture" })).json();
const mouse = new MouseAgent({ springUrl: base, token: enrolled.token });
const heldTunnel = mouse.holdTunnel();
heldTunnel.catch(() => {});
const mouseAbort = new AbortController();
try {
  for (let i = 0; i < 100 && !mouse.tunnelOpen; i++) await sleep(50);
  assert.ok(mouse.tunnelOpen, "fixture Mouse did not connect");
  await api(`/api/providers/${connections[0].id}`, { mouseId: enrolled.mouse.id,
    connectionProxyEnabled: false, connectionProxyUrl: "",
    providerSpecificData: { connectionProxyEnabled: false, connectionProxyUrl: "" } }, "PUT");
  const response = await fetch(base + "/v1/chat/completions", { method: "POST", headers,
    body: JSON.stringify({ model: "qianwen/qwen3.8-flash", stream: true, messages: [{ role: "user", content: "smoke-stage-midstream" }] }),
    signal: AbortSignal.any([mouseAbort.signal, AbortSignal.timeout(15000)]),
  });
  if (response.status !== 200) console.error(JSON.stringify({ event: "smoke.http.failure", endpoint: "/api/v1/chat/completions", status: response.status }));
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  let received = "";
  while (!received.includes("fixture ok")) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false, "Mouse stream ended before first content");
    received += new TextDecoder().decode(chunk.value);
  }
  assert.equal(mouse.activeTasks.size, 1, "request did not run through Mouse");
  assert.ok((await (await fetch(control)).json()).active > 0, "first chunk arrived only after upstream EOF");
  mouseAbort.abort();
  await reader.cancel().catch(() => {});
  for (let i = 0; i < 100; i++) {
    if (!mouse.activeTasks.size && (await (await fetch(control)).json()).active === 0) break;
    await sleep(50);
  }
  assert.equal(mouse.activeTasks.size, 0, "Mouse retained cancelled work");
  assert.equal((await (await fetch(control)).json()).active, 0, "Mouse retained upstream stream");
  console.log(JSON.stringify({ check: "mouse-stream", firstContentBeforeEOF: true, cancellationReleased: true }));
} finally {
  mouseAbort.abort();
  await mouse.stop();
  await heldTunnel.catch(() => {});
  await api(`/api/providers/${connections[0].id}`, { mouseId: null }, "PUT");
}
// Run failure injection last so its 30-second account cooldown cannot mask
// the independent Mouse streaming check above.
await api("/api/combos", { name: "release-fixture-fallback", models: ["qianwen/qwen3.8-flash", "qianwen-token-plan/qwen3.8-flash"], kind: "llm" });
const fallback = await fetch(base + "/v1/chat/completions", { method: "POST", headers, body: JSON.stringify({ model: "release-fixture-fallback", stream: false, messages: [{ role: "user", content: "smoke-stage-fallback" }] }), signal: AbortSignal.timeout(30000) });
assert.equal(fallback.status, 200); await fallback.text();
// Successful HTTP responses must not hide producer-side telemetry loss.
let routingHealth;
for (let i = 0; i < 120; i++) {
  routingHealth = (await (await api("/api/usage/routing-outcomes?processLocal=true&bestEffort=true")).json()).health;
  if (routingHealth && routingHealth.queued === 0 && routingHealth.inFlight === 0) break;
  await sleep(100);
}
assert.ok(routingHealth, "process-local routing health missing");
console.log(JSON.stringify({ check: "routing-delivery", health: routingHealth }));
assert.equal(routingHealth.failed, 0, "routing events exhausted delivery retries");
assert.equal(routingHealth.droppedQueueFull, 0, "routing queue overflow");
assert.equal(routingHealth.droppedInvalid, 0, "invalid routing events");
assert.equal(routingHealth.droppedBytes || 0, 0, "routing payload byte limit exceeded");
assert.equal(routingHealth.sent, routingHealth.enqueued, "routing events were not fully delivered");
// Credentials never enter the report. Fixture traffic records retain only labels.
console.log(JSON.stringify({ ok: true, version: await (await api("/api/version")).json(), matrix, cancellation, connectionIds: connections.map((c) => c.id), realUpstreamVerified: false }));
