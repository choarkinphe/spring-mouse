import assert from "node:assert/strict";
const base = `http://127.0.0.1:${process.env.SMOKE_PORT || 8067}`;
const mock = `http://127.0.0.1:${process.env.MOCK_PORT || 9067}`;
const resultUrl = "https://fixture.example.test/combo-search-result";
const binding = { mode: "gateway", provider: "deepseek", maxResults: 5 };
async function api(route, method = "GET", body, expected = 200) {
  const res = await fetch(`${base}${route}`, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000) });
  const text = await res.text();
  assert.equal(res.status, expected, `${method} ${route}: ${text.slice(0, 2000)}`);
  return JSON.parse(text);
}
const health = await api("/api/health");
assert.equal(health.ok, true);
assert.equal((await fetch(`${mock}/health`).then((r) => r.json())).fixture, "combo-search");
const seeded = (await api("/api/combos")).combos.find((combo) => combo.name === "combo-search-preview");
assert.ok(seeded, "seeded combo must exist");
assert.deepEqual(seeded.search, binding);
// Exercise actual management POST/PUT/GET, not just direct DB seeding.
const name = `combo-search-http-${Date.now()}`;
const combo = await api("/api/combos", "POST", { name, kind: "llm", models: ["combo-search-fixture/search-model"], search: binding }, 201);
try {
  assert.deepEqual(combo.search, binding);
  const route = `/api/combos/${combo.id}`;
  assert.deepEqual((await api(route)).search, binding);
  assert.deepEqual((await api(route, "PUT", { groupName: "Fixture HTTP save" })).search, binding);
  await api(route, "PUT", { search: { ...binding, maxResults: 10 } }, 400);
  assert.deepEqual((await api(route)).search, binding, "invalid save must not mutate config");
  assert.equal((await api(route, "PUT", { search: null })).search, null);
  assert.deepEqual((await api(route, "PUT", { search: binding })).search, binding);
  assert.deepEqual((await api(route)).search, binding);
  const before = await fetch(`${mock}/requests`).then((r) => r.json());
  const protocols = [
    { label: "Chat", route: "/v1/chat/completions", body: { messages: [{ role: "user", content: "Search for the local fixture evidence and cite its URL." }] }, text: (data) => data.choices[0].message.content, terminal: null },
    { label: "Responses", route: "/v1/responses", body: { input: "Search for the local fixture evidence and cite its URL." }, text: (data) => data.output.flatMap((item) => item.content || []).map((part) => part.text || "").join(""), terminal: "response.completed" },
    { label: "Messages", route: "/v1/messages", body: { max_tokens: 256, messages: [{ role: "user", content: [{ type: "text", text: "Search for the local fixture evidence and cite its URL." }] }] }, text: (data) => data.content.map((part) => part.text || "").join(""), terminal: "message_stop" },
  ];
  for (const protocol of protocols) {
    for (const stream of [false, true]) {
      const res = await fetch(`${base}${protocol.route}`, { method: "POST", headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: name, ...protocol.body, stream }), signal: AbortSignal.timeout(120000) });
      const raw = await res.text();
      assert.equal(res.status, 200, `${protocol.label} stream=${stream}: ${raw.slice(0, 2000)}`);
      assert.ok(!raw.includes("spring_mouse_web_search"), "internal search calls must not leak to clients");
      if (!stream) {
        const data = JSON.parse(raw);
        assert.ok(protocol.text(data).includes(resultUrl), `${protocol.label}: missing citation`);
        assert.ok(data.usage && Object.values(data.usage).some((value) => typeof value === "number" && value > 0));
      } else {
        assert.match(res.headers.get("content-type"), /text\/event-stream/);
        const frames = raw.split(/\r?\n\r?\n/).filter((frame) => frame.trim());
        const events = frames.map((frame) => {
          const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          return data === "[DONE]" ? data : JSON.parse(data);
        });
        if (protocol.label === "Chat") {
          assert.equal(events.at(-1), "[DONE]");
          assert.ok(events.filter((event) => event !== "[DONE]").map((event) => event.choices?.[0]?.delta?.content || "").join("").includes(resultUrl));
        } else {
          assert.equal(events.at(-1).type, protocol.terminal);
          const text = protocol.label === "Responses"
            ? events.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta).join("")
            : events.filter((event) => event.type === "content_block_delta").map((event) => event.delta?.text || "").join("");
          assert.ok(text.includes(resultUrl), `${protocol.label} SSE: missing citation`);
        }
      }
      console.log(`PASS ${protocol.label} ${stream ? "SSE" : "JSON"}: tool -> search -> cited final answer`);
    }
  }
  const after = await fetch(`${mock}/requests`).then((r) => r.json());
  assert.deepEqual(after.failures, [], "mock transport assertions failed");
  const fresh = after.requests.slice(before.requests.length);
  assert.equal(fresh.filter((r) => r.kind === "search" && r.count === 5).length, 6);
  assert.equal(fresh.filter((r) => r.kind === "model" && r.phase === "tool_call").length, 6);
  assert.equal(fresh.filter((r) => r.kind === "model" && r.phase === "final" && r.hasResultUrl).length, 6);
  console.log("Combo search fixture verified: management save/validation + Chat/Responses/Messages JSON and SSE, 6 searches and 12 model turns, no paid calls.");
} finally {
  await api(`/api/combos/${combo.id}`, "DELETE");
}
