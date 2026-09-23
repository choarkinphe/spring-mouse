import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The usage table ("最近请求明细 · 使用明细") shows a "用户提问" column: what the
 * user sent, mirroring the provider export's "User Prompt". The prompt is stored
 * on the requestDetails row (so it can be read as a plain column) and joined onto
 * the usage list by `requestId` — which lives inside the detail JSON.
 *
 * These tests pin the whole path: write a detail → it carries userPrompt → the
 * usage list joins it back on requestId.
 */

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "spring-mouse-user-prompt-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function setup() {
  const db = await import("@/lib/db/index.js");
  await db.initDb();
  // batchSize 1 flushes on every write, so the test does not wait on the timer.
  await db.updateSettings({ enableObservability: true, observabilityBatchSize: 1 });
  return db;
}

const flush = () => new Promise((r) => setTimeout(r, 150));

function detail({ id, requestId, prompt }) {
  const now = new Date().toISOString();
  return {
    id,
    requestId,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    connectionId: "conn-1",
    timestamp: now,
    status: "success",
    latency: {},
    tokens: { prompt_tokens: 3, completion_tokens: 4 },
    request: {
      model: "deepseek-v4-flash",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: prompt },
      ],
    },
  };
}

describe("user prompt on the usage detail list", () => {
  it("stores the user's prompt as a column and joins it back by requestId", async () => {
    const db = await setup();
    await db.saveRequestDetail(detail({ id: "d1", requestId: "req-1", prompt: "how do I deploy?" }));
    await flush();

    // The usage row the table lists. Written through the normal path so the
    // requestId the join depends on is real.
    await db.saveRequestUsage({
      requestId: "req-1", provider: "deepseek", model: "deepseek-v4-flash",
      tokens: { prompt_tokens: 3, completion_tokens: 4 }, status: "success",
    });

    const result = await db.getUsageDetails({ page: 1, pageSize: 20 });
    const row = result.details.find((d) => d.requestId === "req-1");
    expect(row).toBeTruthy();
    expect(row.userPrompt).toBe("how do I deploy?");
  });

  it("returns no prompt (not a crash) when the detail row is missing", async () => {
    const db = await setup();
    await db.saveRequestUsage({
      requestId: "req-orphan", provider: "deepseek", model: "m",
      tokens: { prompt_tokens: 1, completion_tokens: 1 }, status: "success",
    });

    const result = await db.getUsageDetails({ page: 1, pageSize: 20 });
    const row = result.details.find((d) => d.requestId === "req-orphan");
    expect(row).toBeTruthy();
    expect(row.userPrompt).toBeUndefined();
  });

  it("falls back to the stored body for rows written before the column existed", async () => {
    const db = await setup();
    // Simulate a legacy row: data carries the messages, userPrompt is NULL.
    const { getAdapter } = await import("@/lib/db/driver.js");
    const adapter = await getAdapter();
    const legacy = detail({ id: "legacy-1", requestId: "req-legacy", prompt: "legacy question" });
    delete legacy.userPrompt;
    adapter.run(
      `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      [legacy.id, legacy.timestamp, legacy.provider, legacy.model, legacy.connectionId, legacy.status, JSON.stringify(legacy)],
    );
    await db.saveRequestUsage({
      requestId: "req-legacy", provider: "deepseek", model: "m",
      tokens: { prompt_tokens: 1, completion_tokens: 1 }, status: "success",
    });

    const result = await db.getUsageDetails({ page: 1, pageSize: 20 });
    const row = result.details.find((d) => d.requestId === "req-legacy");
    expect(row.userPrompt).toBe("legacy question");
  });
});
