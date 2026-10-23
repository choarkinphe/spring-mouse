import assert from "node:assert/strict";

const base = `http://127.0.0.1:${process.env.SMOKE_PORT || 8087}`;
const mock = `http://127.0.0.1:${process.env.MOCK_PORT || 9087}`;
const json = async (url, options) => {
  const response = await fetch(url, options);
  assert.ok(response.ok, `HTTP ${response.status}: ${url}`);
  return response.json();
};
const post = (body, headers = {}) => ({ method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const health = await json(`${base}/api/health`);
assert.equal(health.ok, true);
const { connections } = await json(`${base}/api/providers`);
const connection = connections.find((item) => item.provider === "opencode-go");
assert.ok(connection);
// Refuse to use this verifier against an ordinary development or production account.
assert.equal(connection.name, "Go catalog fixture");
assert.equal((await json(`${mock}/health`)).ok, true);
const key = await json(`${base}/api/keys`, post({ name: "Isolated Go routing verifier" }));
const session = `go-fixture-${crypto.randomUUID()}`;
const headers = { Authorization: `Bearer ${key.key}`, "User-Agent": "Spring-Mouse/routing-fixture", "x-opencode-session": session };
const requests = async () => (await json(`${mock}/requests`)).requests;
const startIndex = (await requests()).length;
const state = (mode) => json(`${mock}/state`, post({ mode }));

try {
  await state("ok");
  assert.equal((await json(`${base}/api/providers/${connection.id}/test`, post({}))).valid, true);
  for (let i = 0; i < 2; i++) {
    const result = await json(`${base}/api/models/test`, post({ model: "opencode-go/glm-5.2" }));
    assert.equal(result.ok, true);
  }
  for (const endpoint of ["/v1/chat/completions", "/v1/messages"]) {
    for (const stream of [false, true]) {
      const response = await fetch(`${base}${endpoint}`, post({ model: "opencode-go/deepseek-v4.1-flash", max_tokens: 40, stream, messages: [{ role: "user", content: "A short coding greeting" }] }, headers));
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.ok(text.includes("Go fixture response"), `${endpoint} stream=${stream}: missing output`);
      assert.ok(!text.includes("event: error"), `${endpoint}: unexpected stream error`);
    }
  }
  const seen = (await requests()).slice(startIndex).filter((item) => item.path === "/chat/completions");
  const probes = seen.filter((item) => item.session?.startsWith("spring-mouse-model-test-"));
  assert.equal(probes.length, 2);
  assert.notEqual(probes[0].session, probes[1].session);
  const conversations = seen.filter((item) => item.model === "deepseek-v4.1-flash");
  assert.equal(conversations.length, 4);
  assert.ok(conversations.every((item) => item.session === session));
  assert.ok(seen.every((item) => item.authorizationPresent && item.userAgent?.startsWith("Spring-Mouse/")));

  await state("reject");
  const validation = await json(`${base}/api/providers/validate`, post({ provider: "opencode-go", apiKey: "sk-fixture-not-real" }));
  assert.equal(validation.valid, false);
  assert.match(validation.error, /400/);
  const rejected = await json(`${base}/api/providers/${connection.id}/test`, post({}));
  assert.equal(rejected.valid, false);
  assert.match(rejected.error, /400/);
  console.log("Go routing verified: health; connection and model probes; unique probe sessions; stable conversation identity; OpenAI/Claude JSON and SSE translation; HTTP 400 rejection remains failure. Only isolated mock upstreams were used.");
} finally {
  await state("ok");
}
