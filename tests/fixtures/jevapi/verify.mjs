import assert from "node:assert/strict";
const base = `http://127.0.0.1:${process.env.SMOKE_PORT || 8037}`;
const call = async (path, body) => {
  const response = await fetch(`${base}${path}`, body === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
};
const providers = await call("/api/providers");
const connection = providers.data.connections.find((item) => item.provider === "jevapi");
assert.ok(connection);
const validation = await call("/api/providers/validate", { provider: "jevapi", apiKey: "fixture-jevapi-key" });
assert.equal(validation.data.valid, true);
const saved = await call(`/api/providers/${connection.id}/test`, {});
assert.equal(saved.data.valid, true);
const models = await call(`/api/providers/${connection.id}/models`);
assert.equal(models.status, 200);
assert.deepEqual(models.data.models.map((m) => [m.id, m.type]), [["jev-latest", "systemone"], ["jev-preview", "systemone"]]);
const sync = await call("/api/providers/model-sync", { providerId: "jevapi", connectionId: connection.id });
assert.equal(sync.status, 200);
assert.equal(sync.data.total, 2);
const custom = await call("/api/models/custom");
assert.deepEqual(custom.data.models.filter((m) => m.providerId === "jevapi").map((m) => [m.id, m.type]), [["jev-latest", "systemone"], ["jev-preview", "systemone"]]);
const questions = {
  urgent: { type: "noul", instructions: "Urgent?" },
  team: { type: "choice", instructions: "Which team?", criteria: { billing: "Payments", technical: "Bugs" } },
  severity: { type: "score", instructions: "How severe?", criteria: ["Low", "Medium", "High"] },
};
for (const model of ["jev-latest", "jevapi/jev-latest"]) {
  const result = await call("/v1/systemone", { model, state: { ticket: "Payouts failed three days" }, questions });
  assert.equal(result.status, 200);
  assert.equal(result.data.answers.urgent.noul, 0.95);
  assert.equal(result.data.answers.team.choice, "billing");
  assert.equal(result.data.answers.severity.score, 1);
  assert.equal(result.data.model, "jev-1.13.0");
  assert.deepEqual(result.data.usage, { input_tokens: 318, output_tokens: 34 });
}
assert.equal((await call("/v1/systemone", null)).status, 400);
assert.equal((await call("/v1/systemone", { model: "jev-latest", state: "hello", questions, stream: true })).status, 400);
assert.equal((await call("/v1/chat/completions", { model: "jevapi/jev-latest", messages: [{ role: "user", content: "hello" }] })).status, 400);
const allowed = (await call("/api/keys", { name: "fixture-allowed" })).data;
const denied = (await call("/api/keys", { name: "fixture-denied" })).data;
assert.ok(allowed.key && denied.key);
const patch = async (body) => {
  const response = await fetch(`${base}/api/settings`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
};
await patch({ systemoneAccessTags: ["jev-users", "admin"], apiKeyAccessTags: { [allowed.id]: ["jev-users"], [denied.id]: ["other"] } });
const nativeRequest = { model: "jev-latest", state: "hello", questions };
const invoke = async (key, model = "jev-latest") => fetch(`${base}/v1/systemone`, {
  method: "POST", headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
  body: JSON.stringify({ ...nativeRequest, model, accessTags: ["jev-users"] }),
});
for (const model of ["jev-latest", "jevapi/jev-latest"]) {
  assert.equal((await invoke(allowed.key, model)).status, 200);
  assert.equal((await invoke(denied.key, model)).status, 403);
}
assert.equal((await invoke()).status, 401);
assert.equal((await invoke("invalid-fixture-key")).status, 401);
await patch({ systemoneAccessTags: [] });
assert.equal((await invoke(denied.key)).status, 200);
console.log("JevAPI fixture verified: native requests, model sync, key validation, interface-tag allow/deny, missing/invalid key rejection, policy removal");
