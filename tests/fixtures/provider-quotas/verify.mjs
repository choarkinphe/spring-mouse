import assert from "node:assert/strict";

const base = `http://127.0.0.1:${process.env.SMOKE_PORT || 8127}`;
const json = async (url) => {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.json();
};
assert.equal((await json(`${base}/api/health`)).ok, true);
const { connections } = await json(`${base}/api/providers`);
const quota = async (provider) => {
  const connection = connections.find((item) => item.provider === provider);
  assert.ok(connection);
  return json(`${base}/api/usage/${connection.id}?force=1`);
};
const go = await quota("opencode-go");
assert.deepEqual(Object.keys(go.quotas).sort(), ["monthly", "rolling", "weekly"]);
assert.deepEqual([go.quotas.rolling.used, go.quotas.weekly.used, go.quotas.monthly.used], [18, 47, 63]);
assert.equal(go.quotas.monthly.remaining, 37);
assert.ok(Object.values(go.quotas).every((item) => item.unit === "%"));
const codex = await quota("codex");
assert.equal(codex.quotas.session.used, 0);
assert.equal(codex.quotas.session.unit, "%");
assert.equal(codex.quotas.session.windowSeconds, 604800);
assert.equal(codex.quotas.weekly, undefined);
const qoder = await quota("qoder");
assert.equal(qoder.quotas.user.unit, "credits");
const deepseek = await quota("deepseek");
assert.equal(Object.values(deepseek.quotas)[0].currency, "CNY");
const codebuddy = await quota("codebuddy-cn");
assert.equal(codebuddy.quotas.Monthly.used, 275.36);
assert.equal(codebuddy.quotas["Bonus Pack 1"].total, 100);
console.log("Provider quota HTTP verified: Go windows, Codex window duration, CodeBuddy credit balances, Qoder credits, DeepSeek currency. Only mocked upstreams and isolated data were used.");
