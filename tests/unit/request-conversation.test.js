import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The board's 模型调用明细 expands a row to show "what did the user send this
 * turn". That view reads a bounded digest from a dedicated endpoint rather than
 * the list endpoint, which deliberately redacts full payloads.
 *
 * Two things must hold:
 *   - a stored (small) body is summarized on read;
 *   - a body already compacted to `_summary` is returned as-is, not re-derived;
 *   - a missing requestId / unknown record is a clean empty result, not a throw.
 */

const originalDataDir = process.env.DATA_DIR;
let tempDir;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "spring-mouse-conversation-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  await db.initDb();
  await db.updateSettings({ enableObservability: true, observabilityBatchSize: 1 });
});

afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function saveDetail(detail) {
  const db = await import("@/lib/db/index.js");
  await db.saveRequestDetail(detail);
  await new Promise((r) => setTimeout(r, 150));
}

async function callConversation(requestId) {
  const { GET } = await import("@/app/api/usage/request-details/conversation/route.js");
  const url = `http://localhost/api/usage/request-details/conversation?requestId=${encodeURIComponent(requestId)}`;
  const response = await GET(new Request(url));
  return { status: response.status, body: await response.json() };
}

describe("request conversation digest endpoint", () => {
  it("summarizes a stored request body on read", async () => {
    await saveDetail({
      id: "conv-1",
      requestId: "req-conv-1",
      provider: "openai",
      model: "gpt-4",
      timestamp: new Date().toISOString(),
      status: "success",
      request: { model: "gpt-4", messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hello there" },
      ] },
    });

    const { status, body } = await callConversation("req-conv-1");
    expect(status).toBe(200);
    expect(body.conversation?.messageCount).toBe(2);
    expect(body.conversation?.messages[1]).toEqual(expect.objectContaining({ role: "user", text: "hello there" }));
  });

  it("returns the stored digest for a compacted body instead of re-deriving it", async () => {
    // compactJsonField stores `_summary` when a body is too large; the endpoint
    // must prefer it so the view matches what was captured.
    await saveDetail({
      id: "conv-2",
      requestId: "req-conv-2",
      provider: "openai",
      model: "gpt-4",
      timestamp: new Date().toISOString(),
      status: "success",
      request: { _truncated: true, _summary: { messageCount: 9, messages: [{ role: "user", text: "captured", chars: 8 }], omittedMessages: 8 } },
    });

    const { body } = await callConversation("req-conv-2");
    expect(body.conversation?.messageCount).toBe(9);
    expect(body.conversation?.messages[0].text).toBe("captured");
  });

  it("returns a clean empty result for an unknown requestId", async () => {
    const { status, body } = await callConversation("req-does-not-exist");
    expect(status).toBe(200);
    expect(body.conversation).toBeNull();
    expect(body.notice).toBeTruthy();
  });

  it("rejects a missing requestId", async () => {
    const { GET } = await import("@/app/api/usage/request-details/conversation/route.js");
    const response = await GET(new Request("http://localhost/api/usage/request-details/conversation"));
    expect(response.status).toBe(400);
  });
});
