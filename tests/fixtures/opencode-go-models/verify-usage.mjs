import assert from "node:assert/strict";

const base = `http://127.0.0.1:${process.env.SMOKE_PORT || 8057}`;
const read = async (url, options) => {
  const response = await fetch(url, options);
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  return data;
};
const { connections } = await read(`${base}/api/providers`);
const connection = connections.find((item) => item.provider === "opencode-go");
assert.ok(connection);
const result = await read(`${base}/api/usage/${connection.id}`);
assert.deepEqual(Object.keys(result.quotas || {}).sort(), ["monthly", "rolling", "weekly"]);
for (const quota of Object.values(result.quotas)) {
  assert.equal(quota.unit, "%");
  assert.ok(Number.isFinite(quota.used) && quota.used >= 0 && quota.used <= 100);
  assert.equal(quota.total, 100);
  assert.equal(quota.remaining, 100 - quota.used);
}
console.log("OpenCode Go usage API returns rolling, weekly, monthly used percentages and upstream reset times.");
