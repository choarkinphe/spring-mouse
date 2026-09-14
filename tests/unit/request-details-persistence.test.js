import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("requestDetails persistence", () => {
  it("keeps requestId and payloads even when observability is off", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sm-request-details-"));
    const previousDataDir = process.env.DATA_DIR;
    const previousObservability = process.env.OBSERVABILITY_ENABLED;
    const previousAdapter = global._dbAdapter;
    process.env.DATA_DIR = dir;
    process.env.OBSERVABILITY_ENABLED = "false";
    delete global._dbAdapter;

    try {
      const repo = await import("../../src/lib/db/repos/requestDetailsRepo.js");
      const base = {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        connectionId: "conn-1",
        timestamp: new Date().toISOString(),
        status: "success",
        latency: { ttft: 10, total: 20 },
        tokens: { prompt_tokens: 1, completion_tokens: 2 },
        request: { messages: [{ role: "user", content: "hello" }] },
        providerRequest: { model: "upstream", padding: "y".repeat(10000) },
        providerResponse: { ok: true },
        response: { content: "world" },
      };

      // The default batch size is 20, so this also exercises the real flush path.
      for (let i = 0; i < 20; i += 1) {
        await repo.saveRequestDetail({ ...base, id: `detail-${i}`, requestId: `req-${i}` });
      }
      await new Promise((resolve) => setTimeout(resolve, 100));

      const detail = await repo.getRequestDetailByRequestId("req-7");
      expect(detail?.requestId).toBe("req-7");
      expect(detail?.request?.messages?.[0]?.content).toBe("hello");
      expect(detail?.providerRequest?.model).toBe("upstream");
      expect(detail?.providerRequest?.padding?.length).toBe(10000);
      expect(detail?.response?.content).toBe("world");
    } finally {
      const { getAdapter } = await import("../../src/lib/db/driver.js");
      const db = await getAdapter().catch(() => null);
      db?.close?.();
      process.env.DATA_DIR = previousDataDir;
      process.env.OBSERVABILITY_ENABLED = previousObservability;
      global._dbAdapter = previousAdapter;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
