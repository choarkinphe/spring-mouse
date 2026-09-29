import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = await mkdtemp(path.join(tmpdir(), "spring-mouse-claude-route-settings-"));

let PATCH;
let GET;
let getClaudeCombos;
let getSettings;
let createCombo;

beforeAll(async () => {
  ({ PATCH, GET } = await import("@/app/api/settings/route.js"));
  ({ GET: getClaudeCombos } = await import("@/app/api/combos/llm/route.js"));
  ({ getSettings, createCombo } = await import("@/lib/localDb"));
});

function patchRequest(body) {
  return new Request("http://localhost/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Claude Messages route setting", () => {
  it("accepts and persists a provider/model target", async () => {
    const res = await PATCH(patchRequest({ claudeMessagesRoute: "  openai/gpt-4o  " }));

    expect(res.status).toBe(200);
    expect((await res.json()).claudeMessagesRoute).toBe("openai/gpt-4o");
    expect((await getSettings()).claudeMessagesRoute).toBe("openai/gpt-4o");
  });

  it("accepts a valid non-empty LLM combo target", async () => {
    await createCombo({ name: "desktop-models", kind: "llm", models: ["openai/gpt-4o"] });

    const res = await PATCH(patchRequest({ claudeMessagesRoute: "desktop-models" }));

    expect(res.status).toBe(200);
    expect((await res.json()).claudeMessagesRoute).toBe("desktop-models");
  });

  it("lists only currently usable LLM combos for the picker", async () => {
    await createCombo({ name: "available-picker-combo", kind: "llm", models: ["openai/gpt-4o"] });
    await createCombo({ name: "empty-picker-combo", kind: "llm", models: [] });
    await createCombo({ name: "disabled-picker-combo", kind: "llm", models: ["openai/gpt-4o"], isActive: false });
    await createCombo({ name: "web-picker-combo", kind: "webSearch", models: ["openai/gpt-4o"] });

    const res = await getClaudeCombos();
    expect(res.status).toBe(200);
    const names = (await res.json()).combos.map((combo) => combo.name);
    expect(names).toContain("available-picker-combo");
    expect(names).not.toContain("empty-picker-combo");
    expect(names).not.toContain("disabled-picker-combo");
    expect(names).not.toContain("web-picker-combo");
  });

  it("rejects a combo whose members are all outside their schedule", async () => {
    await createCombo({
      name: "scheduled-picker-combo",
      kind: "llm",
      models: [{
        model: "openai/gpt-4o",
        schedule: {
          timezone: "UTC",
          active: [],
          inactive: [
            { start: "00:00", end: "12:00" },
            { start: "12:00", end: "00:00" },
          ],
          activeEnabled: true,
          inactiveEnabled: true,
        },
      }],
    });

    const res = await PATCH(patchRequest({ claudeMessagesRoute: "scheduled-picker-combo" }));
    expect(res.status).toBe(400);
  });

  it("clears the route when an empty value is saved", async () => {
    const res = await PATCH(patchRequest({ claudeMessagesRoute: "" }));

    expect(res.status).toBe(200);
    expect((await res.json()).claudeMessagesRoute).toBe("");
    expect((await GET()).status).toBe(200);
    expect((await (await GET()).json()).claudeMessagesRoute).toBe("");
  });

  it.each([
    ["non-string", 42],
    ["whitespace", "openai/gpt 4o"],
    ["leading slash", "/openai/gpt-4o"],
    ["trailing slash", "openai/gpt-4o/"],
  ])("rejects %s route values", async (_label, value) => {
    const res = await PATCH(patchRequest({ claudeMessagesRoute: value }));
    expect(res.status).toBe(400);
  });

  it.each([
    ["missing combo", "does-not-exist"],
    ["empty combo", "empty-desktop-models"],
    ["disabled combo", "disabled-desktop-models"],
    ["non-LLM combo", "web-desktop-models"],
  ])("rejects %s combo targets", async (_label, name) => {
    if (name === "empty-desktop-models") {
      await createCombo({ name, kind: "llm", models: [] });
    } else if (name === "disabled-desktop-models") {
      await createCombo({ name, kind: "llm", models: ["openai/gpt-4o"], isActive: false });
    } else if (name === "web-desktop-models") {
      await createCombo({ name, kind: "webSearch", models: ["openai/gpt-4o"] });
    }

    const res = await PATCH(patchRequest({ claudeMessagesRoute: name }));
    expect(res.status).toBe(400);
  });
});
