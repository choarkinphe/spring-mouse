import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Model sync for channels that have neither a live /models endpoint nor an
// external catalog entry (codebuddy-cn/intl, cline, zed, …). They declare their
// models in the registry, and syncing that list is what makes the channel's
// models selectable in the strict combo picker.

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "spring-mouse-model-sync-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  vi.doMock("next/server", () => ({
    NextResponse: {
      json(body, init = {}) {
        return new Response(JSON.stringify(body), {
          status: init.status || 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  }));
  vi.doMock("@/lib/redis/hotCache.js", () => ({
    getHotJson: vi.fn(async () => null),
    setHotJson: vi.fn(async () => true),
    fillHotJson: vi.fn(async () => true),
    deleteHotJson: vi.fn(async () => true),
    incrementHotCounter: vi.fn(async () => 1),
  }));
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const post = (route, body) => route(new Request("http://localhost/api/providers/model-sync", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
}));

describe("provider model sync", () => {
  it("syncs a registry-only channel from its static model list", async () => {
    const { POST } = await import("@/app/api/providers/model-sync/route.js");
    const { getCustomModels } = await import("@/lib/db/repos/aliasRepo.js");
    const { getModelsByProviderId } = await import("open-sse/config/providerModels.js");

    // codebuddy-cn has no live endpoint and no models.dev key.
    const res = await post(POST, { providerId: "codebuddy-cn", supportedModels: [] });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.staticCount).toBeGreaterThan(0);
    expect(data.officialCount).toBe(0);

    const declared = getModelsByProviderId("codebuddy-cn").map((m) => m.id);
    const stored = (await getCustomModels())
      .filter((m) => m.providerAlias === "cbcn")
      .map((m) => m.id);
    // Every declared model is now selectable, and tagged as coming from the registry.
    expect(new Set(stored)).toEqual(new Set(declared));
    const row = (await getCustomModels()).find((m) => m.providerAlias === "cbcn");
    expect(row.source).toBe("static");
  });

  it("still prefers the live list over the static catalog for the same id", async () => {
    const { POST } = await import("@/app/api/providers/model-sync/route.js");
    const { getCustomModels } = await import("@/lib/db/repos/aliasRepo.js");

    // deepseek has a live endpoint; a live id must keep source "official" and
    // must not be overwritten by the registry's static entry.
    const res = await post(POST, {
      providerId: "deepseek",
      supportedModels: [{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" }],
    });
    const data = await res.json();
    expect(res.status).toBe(200);

    const row = (await getCustomModels()).find((m) => m.providerAlias === "ds" && m.id === "deepseek-v4-pro");
    expect(row).toBeTruthy();
    expect(row.source).toBe("official");
    expect(row.name).toBe("DeepSeek V4 Pro");
  });

  it("rejects a channel with no live, catalog or static source", async () => {
    const { POST } = await import("@/app/api/providers/model-sync/route.js");
    const res = await post(POST, { providerId: "not-a-real-provider", supportedModels: [] });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/does not support/i);
  });
});
