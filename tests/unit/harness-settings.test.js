import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = await mkdtemp(path.join(tmpdir(), "spring-mouse-harness-settings-"));

let PATCH;
let getCombos;
let getSettings;
let createCombo;

beforeAll(async () => {
  ({ PATCH } = await import("@/app/api/settings/route.js"));
  ({ GET: getCombos } = await import("@/app/api/combos/llm/route.js"));
  ({ getSettings, createCombo } = await import("@/lib/localDb"));
});

function patchRequest(body) {
  return new Request("http://localhost/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const comboListRequest = (query = "") =>
  new Request(`http://localhost/api/combos/llm${query}`);

describe("harnessProfiles validation", () => {
  it("accepts a mapping whose combo is merely outside its schedule", async () => {
    // A combo that is dark right now is still a valid durable target — the
    // dashboard lists it annotated rather than hiding it, so it must be
    // saveable, otherwise the annotation would be a dead end.
    await createCombo({
      name: "dark-combo",
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

    const res = await PATCH(patchRequest({
      harnessProfiles: {
        "claude-code": { enabled: true, mappings: [{ match: "claude-*", target: "dark-combo" }] },
      },
    }));

    expect(res.status).toBe(200);
    expect((await getSettings()).harnessProfiles["claude-code"].mappings)
      .toEqual([{ match: "claude-*", target: "dark-combo" }]);
  });

  it("still rejects a target combo that does not exist", async () => {
    const res = await PATCH(patchRequest({
      harnessProfiles: {
        codex: { enabled: true, mappings: [{ match: "gpt-*", target: "nope-not-here" }] },
      },
    }));

    expect(res.status).toBe(400);
  });

  it("accepts a provider/model target without looking it up", async () => {
    const res = await PATCH(patchRequest({
      harnessProfiles: {
        codex: { enabled: true, mappings: [{ match: "gpt-5*", target: "cx/gpt-5.6-sol" }] },
      },
    }));

    expect(res.status).toBe(200);
  });
});

describe("harnessModels validation", () => {
  it("persists operator-added ids, dropping duplicates and invalid entries", async () => {
    const res = await PATCH(patchRequest({
      harnessModels: {
        "claude-code": ["claude-opus-next", "claude-opus-5", "claude-opus-4-6", "has space"],
        codex: [],
        "not-a-harness": ["whatever"],
      },
    }));

    expect(res.status).toBe(200);
    const stored = (await getSettings()).harnessModels;
    expect(stored["claude-code"]).toEqual(["claude-opus-next"]);
    expect(stored.codex).toBeUndefined();
    expect(stored["not-a-harness"]).toBeUndefined();
  });

  it("rejects a non-object value", async () => {
    const res = await PATCH(patchRequest({ harnessModels: "nope" }));
    expect(res.status).toBe(400);
  });
});

describe("combo picker availability", () => {
  it("hides unavailable combos by default so the legacy picker is unchanged", async () => {
    await createCombo({ name: "picker-live", kind: "llm", models: ["openai/gpt-4o"] });
    await createCombo({ name: "picker-disabled", kind: "llm", models: ["openai/gpt-4o"], isActive: false });
    await createCombo({ name: "picker-web", kind: "webSearch", models: ["openai/gpt-4o"] });

    const res = await getCombos(comboListRequest());
    const names = (await res.json()).combos.map((combo) => combo.name);

    expect(names).toContain("picker-live");
    expect(names).not.toContain("picker-disabled");
    expect(names).not.toContain("picker-web");
  });

  it("adds the schedule-dark combos when includeUnavailable is set", async () => {
    const res = await getCombos(comboListRequest("?includeUnavailable=1"));
    const combos = (await res.json()).combos;
    const byName = Object.fromEntries(combos.map((combo) => [combo.name, combo]));

    expect(byName["picker-live"]).toMatchObject({ available: true, unavailableReason: null });
    // A combo in a schedule gap is a valid durable target, so it is listed and
    // annotated rather than hidden.
    expect(byName["dark-combo"]).toMatchObject({
      available: false,
      unavailableReason: "scheduled-out",
    });
    // Structural rejects stay filtered in BOTH modes: the settings PATCH refuses
    // them, so offering them would be a choice the save rejects.
    expect(byName["picker-disabled"]).toBeUndefined();
    expect(byName["picker-web"]).toBeUndefined();
  });

  it("omits member ids by default so the legacy response shape is unchanged", async () => {
    // The Claude Messages picker reads this endpoint without the flag; adding a
    // field unconditionally would change a response other callers already parse.
    const res = await getCombos(comboListRequest());
    const combos = (await res.json()).combos;

    // Guard the loop below against passing vacuously on an empty list.
    expect(combos.length).toBeGreaterThan(0);
    for (const combo of combos) expect(combo).not.toHaveProperty("models");
  });

  it("attaches configured member ids when includeMembers is set", async () => {
    await createCombo({
      name: "picker-members",
      kind: "llm",
      // Member entries may be objects, and a schedule must not filter the
      // vocabulary: the harness picker offers every configured member id as a
      // target even while one is outside its window, because availability is
      // re-checked when the request actually arrives.
      models: [
        { model: "cx/gpt-5.6-sol" },
        "openai/gpt-4o",
        { model: "cx/gpt-5.6-sol" },
        {
          model: "dark-member",
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
        },
      ],
    });

    const res = await getCombos(comboListRequest("?includeUnavailable=1&includeMembers=1"));
    const combos = (await res.json()).combos;
    const byName = Object.fromEntries(combos.map((combo) => [combo.name, combo]));

    // De-duplicated, order-preserving, and schedule-ignored.
    expect(byName["picker-members"].models)
      .toEqual(["cx/gpt-5.6-sol", "openai/gpt-4o", "dark-member"]);
    // A combo in a schedule gap still reports its members, so an operator can
    // point a tool straight at one of them.
    expect(byName["dark-combo"].models).toEqual(["openai/gpt-4o"]);
  });
});
