import { readFileSync } from "node:fs";
import vm from "node:vm";
import { expect, it } from "vitest";

it("release HTTP smoke synchronizes through a real connection and checks the official snapshot", async () => {
  const source = readFileSync(new URL("../fixtures/release-smoke/verify.mjs", import.meta.url), "utf8");
  const start = source.indexOf("const connections = [];");
  const end = source.indexOf("// Verify tag filtering", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const calls = [];
  const rows = new Map();
  const context = {
    assert: {
      equal: (actual, expected, message) => expect(actual, message).toBe(expected),
      deepEqual: (actual, expected, message) => expect(JSON.parse(JSON.stringify(actual)), message).toEqual(JSON.parse(JSON.stringify(expected))),
      ok: (value, message) => expect(value, message).toBeTruthy(),
    },
    api: async (path, body) => {
      calls.push({ path, body });
      if (path === "/api/providers") {
        const connection = { id: `fixture-${body.provider}`, provider: body.provider };
        rows.set(body.provider, connection);
        return Response.json({ connection });
      }
      if (path.endsWith("/test")) return Response.json({ valid: true });
      if (path.startsWith("/api/providers/") && path.endsWith("/models")) return Response.json({ models: [{ id: "qwen3.8-flash" }], discovery: { status: "success", source: "official" } });
      if (path === "/api/providers/model-sync") {
        expect(body).toEqual({ providerId: body.providerId, connectionId: `fixture-${body.providerId}` });
        expect(body).not.toHaveProperty("supportedModels");
        expect(body).not.toHaveProperty("officialFetched");
        return Response.json({ total: 1, catalogCount: 0, staticCount: 0 });
      }
      if (path === "/api/models/custom") return Response.json({ snapshots: Object.fromEntries([...rows].map(([provider, conn]) => [provider, { source: "official", connectionId: conn.id, modelIds: ["qwen3.8-flash"] }])) });
      if (path === "/api/models") return Response.json({ models: [...rows.keys()].map((provider) => ({ provider, model: "qwen3.8-flash" })) });
      throw new Error(`Unexpected smoke endpoint: ${path}`);
    },
  };
  const script = new vm.Script(`(async () => { ${source.slice(start, end)} })()`);
  await script.runInNewContext(context);
  expect(calls.filter((call) => call.path === "/api/providers/model-sync")).toHaveLength(2);
  expect(calls.filter((call) => call.path === "/api/models/custom")).toHaveLength(2);
});
