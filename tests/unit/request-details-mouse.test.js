// The executed Mouse node has to survive the write path to be visible in the
// console drawer and in the chat-debug panel's server-side reconciliation.
//
// `prepareRecord()` is an explicit whitelist, so an unknown key is dropped
// without an error — a node added to the record but not to the whitelist would
// silently vanish between buildRequestDetail() and the row.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

async function saveDetail(detail) {
  await db.saveRequestDetail(detail);
  await new Promise((r) => setTimeout(r, 120));
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "spring-mouse-mouse-detail-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  await db.updateSettings({ enableObservability2: true, observabilityBatchSize: 1 });
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const MOUSE = { id: "11112222-3333-4444-5555-666677778888", name: "tokyo-edge" };

describe("request details — executed Mouse node", () => {
  it("persists the node id and name through the write/read round-trip", async () => {
    await saveDetail({
      id: "mouse-detail-1",
      provider: "openai",
      model: "gpt-4o",
      mouse: MOUSE,
      status: "success",
      latency: { ttft: 12, total: 34 },
      request: { model: "gpt-4o" },
      response: { content: "hi" },
    });

    const { details } = await db.getRequestDetails({ model: "gpt-4o" });
    const hit = details.find((d) => d.id === "mouse-detail-1");
    expect(hit).toBeTruthy();
    expect(hit.mouse).toEqual(MOUSE);
  });

  it("leaves the field absent for a request that ran on the Spring host", async () => {
    await saveDetail({
      id: "host-detail-1",
      provider: "anthropic",
      model: "claude-3",
      status: "success",
      request: { model: "claude-3" },
      response: { content: "hi" },
    });

    const viaId = await db.getRequestDetailById("host-detail-1");
    expect(viaId.mouse).toBeUndefined();
  });
});
