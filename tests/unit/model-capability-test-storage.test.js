import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSqlJsAdapter } from "@/lib/db/adapters/sqljsAdapter.js";

const state = vi.hoisted(() => ({ adapter: null }));
vi.mock("@/lib/db/driver.js", () => ({ getAdapter: async () => state.adapter }));
vi.mock("@/lib/redis/hotCache.js", () => ({ deleteHotJson: vi.fn(async () => {}) }));
const { claimModelCapabilityTest, saveModelCapabilityTest, getModelCapabilityTests, deleteModelCapabilityTests } = await import("@/lib/db/repos/modelCapabilityTestsRepo.js");
const { runCapabilityTests, normalizeProbeOptions } = await import("@/lib/modelCapabilities/runner.js");
let dir, file;
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sm-capability-test-"));
  file = path.join(dir, "data.sqlite");
  state.adapter = await createSqlJsAdapter(file);
  state.adapter.exec("CREATE TABLE kv (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY(scope,key))");
});
afterAll(() => { state.adapter.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const identity = { providerId: "p", connectionId: "a", modelId: "vendor/model" };
const report = (runId, status = "supported") => ({ runId, fingerprint: "fp", probeVersion: 1, completedAt: new Date().toISOString(), results: { vision: { status } } });

describe("SQLite capability archives", () => {
  it("claims one run atomically and prevents old runs overwriting new ones", async () => {
    expect(await claimModelCapabilityTest(identity, report("one"))).toBe(true);
    expect(await claimModelCapabilityTest(identity, report("two"))).toBe(false);
    expect(await saveModelCapabilityTest(identity, report("wrong"), { final: true })).toBe(false);
    await saveModelCapabilityTest(identity, report("one"), { final: true });
    expect(await claimModelCapabilityTest(identity, report("two"))).toBe(true);
    expect(await saveModelCapabilityTest(identity, report("one"), { final: true })).toBe(false);
    await saveModelCapabilityTest(identity, report("two", "unknown"), { final: true });
  });
  it("retains reliable evidence after an inconclusive retry and persists before reopen", async () => {
    const [profile] = await getModelCapabilityTests(identity);
    expect(profile.latest.results.vision.status).toBe("unknown");
    expect(profile.evidence.vision.status).toBe("supported");
    const reader = await createSqlJsAdapter(file);
    expect(JSON.parse(reader.get("SELECT value FROM kv WHERE scope = 'modelCapabilityTests'").value).evidence.vision.status).toBe("supported");
    reader.close();
  });
  it("bounds history and isolates accounts/model ids containing slashes", async () => {
    for (let n = 0; n < 12; n++) {
      await claimModelCapabilityTest(identity, report(`run-${n}`));
      await saveModelCapabilityTest(identity, report(`run-${n}`), { final: true });
    }
    const second = { ...identity, connectionId: "b" };
    await claimModelCapabilityTest(second, report("other"));
    await saveModelCapabilityTest(second, report("other", "unsupported"), { final: true });
    expect((await getModelCapabilityTests(identity))[0].history.length).toBe(10);
    expect((await getModelCapabilityTests(second))[0].evidence.vision.status).toBe("unsupported");
    await deleteModelCapabilityTests(second);
    expect(await getModelCapabilityTests(second)).toEqual([]);
  });
});

describe("probe runner budgets and partial reports", () => {
  it("retains a verified lower bound when a later deep run discovers an upper limit", async () => {
    const id = { providerId: "limits", connectionId: "limits", modelId: "limits" };
    const first = { ...report("lower"), results: { contextWindow: { status: "supported", context: { verifiedRetrievalTokens: 4096 } } } };
    await claimModelCapabilityTest(id, first); await saveModelCapabilityTest(id, first, { final: true });
    const second = { ...report("upper"), results: { contextWindow: { status: "supported", context: { verifiedRetrievalTokens: null, explicitLimit: 12000, limitKind: "total" } } } };
    await claimModelCapabilityTest(id, second); await saveModelCapabilityTest(id, second, { final: true });
    expect((await getModelCapabilityTests(id))[0].evidence.contextWindow.context).toMatchObject({ verifiedRetrievalTokens: 4096, explicitLimit: 12000 });
  });
  const connection = { id: "runner", provider: "openai-compatible-chat-test" };
  const execute = async (id, probe) => ({ success: true, dispatched: true, preserved: true, json: { choices: [{ message: { content: probe.expected.join(",") } }], usage: { prompt_tokens: 4096, completion_tokens: 20 } } });
  it("saves a successful context lower bound without overwriting its maximum", async () => {
    const result = await runCapabilityTests(connection, "ctx", normalizeProbeOptions({ tests: ["contextWindow"] }), { signal: new AbortController().signal, execute });
    expect(result.results.contextWindow.context.verifiedRetrievalTokens).toBe(4096);
    expect(result.results.contextWindow.context.explicitLimit).toBeUndefined();
    expect((await getModelCapabilityTests({ connectionId: "runner", modelId: "ctx" }))[0].latest.status).toBe("completed");
  });
  it("stops deep probes at the request budget", async () => {
    const call = vi.fn(execute);
    const result = await runCapabilityTests(connection, "deep", normalizeProbeOptions({ mode: "deep", maxRequests: 2 }), { signal: new AbortController().signal, execute: call });
    expect(call).toHaveBeenCalledTimes(2);
    expect(result.results.contextWindow.steps).toHaveLength(2);
  });
  it("persists completed projects when the user cancels", async () => {
    const controller = new AbortController();
    const result = await runCapabilityTests(connection, "cancel", normalizeProbeOptions({ tests: ["text", "vision"] }), {
      signal: controller.signal, execute,
      emit: (event) => { if (event.type === "result") controller.abort("cancel"); },
    });
    expect(result.status).toBe("cancelled");
    expect(result.results.text.status).toBe("supported");
    expect(result.results.vision.status).toBe("untested");
    expect((await getModelCapabilityTests({ connectionId: "runner", modelId: "cancel" }))[0].evidence.text.status).toBe("supported");
  });
});
