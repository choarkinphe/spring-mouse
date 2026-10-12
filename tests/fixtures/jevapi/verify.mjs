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
const sync = await call("/api/providers/model-sync", { providerId: "jevapi", supportedModels: models.data.models, officialFetched: true });
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
console.log("JevAPI fixture verified: model listing, key validation, saved account test, native primitives, bare/qualified names, chat rejection");
