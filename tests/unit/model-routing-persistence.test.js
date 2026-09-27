import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "spring-mouse-model-persistence-"));
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

describe("model routing persistence", () => {
  it("stores routing in usage metadata and returns it from recent/detail readers", async () => {
    const { saveRequestUsage, getUsageHistory, getUsageDetails, getUsageStats } = await import("../../src/lib/db/repos/usageRepo.js");
    const timestamp = new Date().toISOString();

    await saveRequestUsage({
      requestId: "routing-usage-1",
      startedAt: timestamp,
      completedAt: timestamp,
      provider: "openai",
      model: "gpt-4o-mini",
      originalModel: "balanced",
      executedModel: "openai/gpt-4o-mini",
      routing: {
        originalModel: "balanced",
        executedModel: "openai/gpt-4o-mini",
        routeKind: "alias",
        routed: true,
      },
      status: "success",
      tokens: { prompt_tokens: 2, completion_tokens: 1 },
    });

    const db = await import("../../src/lib/db/driver.js").then(({ getAdapter }) => getAdapter());
    const stored = db.get("SELECT meta FROM usageHistory WHERE requestId = ?", ["routing-usage-1"]);
    expect(JSON.parse(stored.meta).routing).toEqual({
      originalModel: "balanced",
      executedModel: "openai/gpt-4o-mini",
      routeKind: "alias",
      routed: true,
    });

    await expect(getUsageHistory()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        originalModel: "balanced",
        executedModel: "openai/gpt-4o-mini",
        routing: {
          originalModel: "balanced",
          executedModel: "openai/gpt-4o-mini",
          routeKind: "alias",
          routed: true,
        },
      }),
    ]));

    const details = await getUsageDetails({ page: 1, pageSize: 10 });
    expect(details.details[0]).toEqual(expect.objectContaining({
      requestId: "routing-usage-1",
      originalModel: "balanced",
      executedModel: "openai/gpt-4o-mini",
      routing: {
        originalModel: "balanced",
        executedModel: "openai/gpt-4o-mini",
        routeKind: "alias",
        routed: true,
      },
    }));

    const stats = await getUsageStats("today");
    expect(stats.recentCallDetails[0]).toEqual(expect.objectContaining({
      originalModel: "balanced",
      executedModel: "openai/gpt-4o-mini",
      routing: {
        originalModel: "balanced",
        executedModel: "openai/gpt-4o-mini",
        routeKind: "alias",
        routed: true,
      },
    }));
  });

  it("preserves routing in the usage-only request-detail fallback", async () => {
    const { saveRequestUsage } = await import("../../src/lib/db/repos/usageRepo.js");
    const { getRequestDetailByRequestId } = await import("../../src/lib/db/repos/requestDetailsRepo.js");
    const timestamp = new Date().toISOString();

    await saveRequestUsage({
      requestId: "routing-fallback-1",
      startedAt: timestamp,
      completedAt: timestamp,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      originalModel: "strong",
      executedModel: "deepseek/deepseek-v4-flash",
      routing: {
        originalModel: "strong",
        executedModel: "deepseek/deepseek-v4-flash",
      },
      status: "success",
      tokens: { prompt_tokens: 1, completion_tokens: 1 },
    });

    await expect(getRequestDetailByRequestId("routing-fallback-1")).resolves.toEqual(expect.objectContaining({
      status: "usage-only",
      originalModel: "strong",
      executedModel: "deepseek/deepseek-v4-flash",
      routing: {
        originalModel: "strong",
        executedModel: "deepseek/deepseek-v4-flash",
      },
    }));
  });
});
