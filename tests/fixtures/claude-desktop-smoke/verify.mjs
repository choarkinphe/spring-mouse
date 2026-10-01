import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const { key } = JSON.parse(await readFile(`${process.env.DATA_DIR}/smoke-key.json`, "utf8"));
const base = `http://127.0.0.1:${process.env.SMOKE_PORT || 8017}`;
const headers = { "x-api-key": key, "anthropic-version": "2023-06-01" };
const discovery = await fetch(`${base}/v1/models`, { headers });
assert.equal(discovery.status, 200);
const list = await discovery.json();
const model = list.data.find(m => m.anthropic_family_tier === "sonnet");
assert.ok(model);
assert.equal(model.id, "deepseek-flash");
assert.equal(model.type, "model");
assert.equal(list.has_more, false);
console.log('[smoke] PASS authenticated Anthropic discovery:', JSON.stringify(list));
const openai = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${key}` } });
const other = await openai.json();
assert.equal(other.object, "list");
assert.equal(other.data.find(m => m.id === model.id).anthropic_family_tier, "sonnet");
console.log('[smoke] PASS headerless Bearer discovery');
for (const invalidHeaders of [{}, { "x-api-key": "invalid-smoke-key" }]) {
  assert.equal((await fetch(`${base}/v1/models`, { headers: invalidHeaders })).status, 401);
}
console.log('[smoke] PASS missing/invalid credential rejection');
for (const id of [model.id, "claude-sonnet-4-5"]) {
  for (const stream of [false, true]) {
    const response = await fetch(`${base}/v1/messages`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ model: id, stream, max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    if (stream) {
      assert.match(text, /event: message_start/);
      assert.match(text, /event: content_block_delta/);
      assert.match(text, /hello from mock/);
      assert.match(text, /event: message_stop/);
      assert.doesNotMatch(text, /event: error/);
    } else {
      const message = JSON.parse(text);
      assert.equal(message.type, "message");
      assert.equal(message.role, "assistant");
      assert.ok(message.content.some(block => block.type === "text" && block.text));
    }
    console.log(`[smoke] PASS ${id} stream=${stream}: ${text.slice(0, 220)}`);
  }
}
const migrated = await fetch(`${base}/api/settings`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    harnessProfiles: {
      "claude-code": { enabled: true, mappings: [{ match: "claude-*", target: model.id }] },
    },
  }),
});
assert.equal(migrated.status, 200, await migrated.text());
for (const id of ["claude-sonnet-5-5", "claude-opus-5"]) {
  for (const endpoint of ["/v1/messages", "/api/v1/messages"]) {
    const response = await fetch(`${base}${endpoint}`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ model: id, stream: false, max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
    });
    const text = await response.text();
    assert.equal(response.status, 404, text);
    assert.match(text, /No active credentials for provider/);
    console.log(`[smoke] PASS migrated ${endpoint} ${id}: 404, legacy combo ignored`);
  }
  for (const stream of [false, true]) {
    const response = await fetch(`${base}/claude-code/v1/messages`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ model: id, stream, max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.match(text, /hello from mock/);
    if (stream) assert.match(text, /event: message_stop/);
    console.log(`[smoke] PASS migrated Harness ${id} stream=${stream}: 200, explicit mapping used`);
  }
}
console.log('[smoke] ALL HTTP CHECKS PASSED');
