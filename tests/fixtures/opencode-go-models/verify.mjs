import assert from "node:assert/strict";

const base = `http://127.0.0.1:${process.env.SMOKE_PORT || 8057}`;
const mock = `http://127.0.0.1:${process.env.MOCK_PORT || 9057}`;
const read = async (url) => {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.json();
};
const setMode = async (mode) => {
  const response = await fetch(`${mock}/state`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) });
  assert.equal(response.status, 200);
};
const { connections } = await read(`${base}/api/providers`);
const connection = connections.find((item) => item.provider === "opencode-go");
assert.ok(connection);
const listingUrl = `${base}/api/providers/${connection.id}/models`;
const rows = async () => (await read(`${base}/api/models/custom`)).models.filter((item) => item.providerAlias === "ocg");
const sync = async (supportedModels, officialFetched = true) => {
  const response = await fetch(`${base}/api/providers/model-sync`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerId: "opencode-go", supportedModels, officialFetched }) });
  return { status: response.status, body: await response.json() };
};
try {
  await setMode("ok");
  const listing = await read(listingUrl);
  assert.equal(listing.listingScope, "public");
  assert.deepEqual(listing.models.map((item) => item.id), ["kimi-k3", "deepseek-v4.1-flash", "minimax-m3"]);
  assert.deepEqual(listing.models.find((item) => item.id === "minimax-m3").supportedFormats, ["openai", "claude"]);
  const result = await sync(listing.models);
  assert.equal(result.status, 200);
  assert.equal(result.body.total, 3);
  assert.equal(result.body.staticCount, 0);
  const after = await rows();
  assert.deepEqual(after.map((item) => item.id).sort(), ["manual-keep", ...listing.models.map((item) => item.id)].sort());
  const manual = after.find((item) => item.id === "manual-keep");
  assert.equal(manual.source, undefined);
  for (const mode of ["error", "malformed"]) {
    await setMode(mode);
    const response = await fetch(listingUrl);
    assert.equal(response.status, mode === "error" ? 503 : 502);
    assert.deepEqual(await rows(), after);
  }
  const failedSync = await sync([], false);
  assert.equal(failedSync.status, 502);
  assert.deepEqual(await rows(), after);
  await setMode("empty");
  const empty = await read(listingUrl);
  assert.deepEqual(empty.models, []);
  assert.equal((await sync(empty.models)).status, 200);
  assert.deepEqual((await rows()).map((item) => item.id), ["manual-keep"]);
  const requests = (await read(`${mock}/requests`)).requests;
  assert.ok(requests.length >= 4);
  assert.ok(requests.every((item) => item.authorizationPresent === false));
  console.log("Go catalog verified: public GET, protocol metadata, authoritative sync, stale removal, manual preservation, upstream failures, malformed response and empty catalog. Only the manual model remains, ready for browser candidate search and re-sync.");
} finally {
  await setMode("ok");
}
