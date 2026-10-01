import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.DATA_DIR = await mkdtemp(path.join(tmpdir(), "harness-independent-"));
let PATCH, getSettings, updateSettings;
beforeAll(async () => {
  ({ PATCH } = await import("@/app/api/harnesses/[prefix]/route.js"));
  ({ getSettings, updateSettings } = await import("@/lib/db/index.js"));
});
beforeEach(async () => {
  await updateSettings({ harnessProfiles: {}, harnessModels: {}, claudeMessagesRoute: "" });
});
const profile = (match = "gpt-*", target = "openai/gpt-6", enabled = true) => ({
  enabled, mappings: [{ match, target }],
});
const save = (prefix, data) => PATCH(new Request("http://localhost/api/harnesses/" + prefix, {
  method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
}), { params: Promise.resolve({ prefix }) });

describe("independent harness saves", () => {
  it("updates only one profile and model list, preserving unrelated settings", async () => {
    await updateSettings({
      harnessProfiles: { codex: profile(), "claude-code": profile("claude-*", "p/model") },
      harnessModels: { codex: ["gpt-next"], "claude-code": ["claude-next"] },
      customUnrelated: "keep",
    });
    const response = await save("claude-desktop", { profile: profile("claude-fable-*", "p/fable", false), models: ["claude-custom"] });
    expect(response.status).toBe(200);
    const settings = await getSettings();
    expect(settings.harnessProfiles.codex).toEqual(profile());
    expect(settings.harnessProfiles["claude-code"]).toEqual(profile("claude-*", "p/model"));
    expect(settings.harnessProfiles["claude-desktop"].enabled).toBe(false);
    expect(settings.harnessModels.codex).toEqual(["gpt-next"]);
    expect(settings.harnessModels["claude-code"]).toEqual(["claude-next"]);
    expect(settings.customUnrelated).toBe("keep");
  });

  it("materializes legacy Desktop when saving Codex first", async () => {
    await updateSettings({ claudeMessagesRoute: "legacy-combo" });
    expect((await save("codex", { profile: profile(), models: [] })).status).toBe(200);
    expect((await getSettings()).harnessProfiles["claude-desktop"].mappings)
      .toEqual([{ match: "claude-*", target: "legacy-combo" }]);
  });

  it("clears only the selected custom list and accepts an empty disabled profile", async () => {
    await updateSettings({ harnessModels: { codex: ["gpt-next"], "claude-code": ["claude-next"] } });
    const response = await save("codex", { profile: { enabled: false, mappings: [] }, models: [] });
    expect(response.status).toBe(200);
    const settings = await getSettings();
    expect(settings.harnessModels).toEqual({ "claude-code": ["claude-next"] });
    expect(settings.harnessProfiles.codex).toMatchObject({ enabled: false, mappings: [] });
  });

  it("does not lose concurrent updates to different prefixes", async () => {
    const responses = await Promise.all([
      save("codex", { profile: profile(), models: ["gpt-next"] }),
      save("claude-code", { profile: profile("claude-*", "p/model"), models: ["claude-next"] }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const settings = await getSettings();
    expect(Object.keys(settings.harnessProfiles).sort()).toEqual(["claude-code", "codex"]);
    expect(settings.harnessModels).toEqual({ codex: ["gpt-next"], "claude-code": ["claude-next"] });
  });

  it("rejects unknown prefixes, malformed bodies and missing combos without writing", async () => {
    expect((await save("other", { profile: profile(), models: [] })).status).toBe(404);
    expect((await save("codex", { profile: {}, models: "bad" })).status).toBe(400);
    expect((await save("codex", { profile: profile("gpt-*", "missing-combo"), models: [] })).status).toBe(400);
    expect((await getSettings()).harnessProfiles).toEqual({});
  });

  it("rejects async settings updaters and preserves object-based updates", async () => {
    await expect(updateSettings(async () => ({ customUnrelated: "bad" }))).rejects.toThrow("synchronous");
    await updateSettings({ customUnrelated: "ok" });
    expect((await getSettings()).customUnrelated).toBe("ok");
  });
});
