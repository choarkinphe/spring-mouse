import { describe, it, expect, beforeEach } from "vitest";

import {
  getActiveComboModels,
  getComboModelsFromData,
  getRotatedModels,
  isComboModelActive,
  normalizeComboModelsForStorage,
  resetComboRotation,
} from "../../open-sse/services/combo.js";

describe("combo round-robin routing", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  it("keeps existing one-request round-robin behavior by default", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 4 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin")[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-b",
      "provider/model-a",
      "provider/model-b",
    ]);
  });

  it("sticks to each combo model for the configured number of requests", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 6 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-a",
      "provider/model-b",
      "provider/model-b",
      "provider/model-a",
      "provider/model-a",
    ]);
  });

  it("tracks sticky rotation independently per combo", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-b");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
  });

  it("does not rotate fallback combos", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
  });
});

describe("combo model schedules", () => {
  it("supports multiple active windows with inactive windows taking precedence", () => {
    const entry = {
      model: "premium/model",
      schedule: {
        timezone: "UTC",
        active: [
          { start: "09:00", end: "10:00" },
          { start: "14:00", end: "15:00" },
        ],
        inactive: [{ start: "09:30", end: "09:45" }],
        activeEnabled: true,
        inactiveEnabled: true,
      },
    };

    expect(isComboModelActive(entry, new Date("2026-08-19T09:15:00Z"))).toBe(true);
    expect(isComboModelActive(entry, new Date("2026-08-19T09:40:00Z"))).toBe(false);
    expect(isComboModelActive(entry, new Date("2026-08-19T11:00:00Z"))).toBe(false);
    expect(isComboModelActive(entry, new Date("2026-08-19T14:30:00Z"))).toBe(true);
  });

  it("treats disabled active windows as all day and subtracts enabled inactive windows", () => {
    const entry = {
      model: "day-model",
      schedule: {
        timezone: "UTC",
        active: [{ start: "09:00", end: "10:00" }],
        inactive: [{ start: "12:00", end: "13:00" }],
        activeEnabled: false,
        inactiveEnabled: true,
      },
    };

    expect(isComboModelActive(entry, new Date("2026-08-19T08:00:00Z"))).toBe(true);
    expect(isComboModelActive(entry, new Date("2026-08-19T12:30:00Z"))).toBe(false);
  });

  it("ignores disabled inactive windows", () => {
    const entry = {
      model: "ignore-inactive/model",
      schedule: {
        timezone: "UTC",
        active: [],
        inactive: [{ start: "00:00", end: "23:59" }],
        activeEnabled: true,
        inactiveEnabled: false,
      },
    };

    expect(isComboModelActive(entry, new Date("2026-08-19T12:00:00Z"))).toBe(true);
  });

  it("keeps the legacy single-window schedule shape working", () => {
    const entry = {
      model: "legacy/model",
      schedule: { start: "09:00", end: "12:00", timezone: "Asia/Shanghai" },
    };

    expect(isComboModelActive(entry, new Date("2026-08-19T02:30:00Z"))).toBe(true);
    expect(isComboModelActive(entry, new Date("2026-08-19T04:30:00Z"))).toBe(false);
  });

  it("supports windows that cross midnight", () => {
    const entry = {
      model: "night/model",
      schedule: {
        timezone: "Asia/Shanghai",
        active: [{ start: "22:00", end: "06:00" }],
        inactive: [],
        activeEnabled: true,
        inactiveEnabled: false,
      },
    };

    expect(isComboModelActive(entry, new Date("2026-08-19T17:30:00Z"))).toBe(true); // 01:30 next day
    expect(isComboModelActive(entry, new Date("2026-08-19T08:30:00Z"))).toBe(false); // 16:30
  });

  it("does not resolve disabled combos", () => {
    const combo = { name: "paused-route", isActive: false, models: ["provider/model"] };

    expect(getComboModelsFromData("paused-route", [combo])).toBeNull();
  });

  it("returns an empty route when every configured node is outside its window", () => {
    const combo = {
      name: "night-only",
      models: [{
        model: "night/model",
        schedule: {
          timezone: "UTC",
          active: [{ start: "01:00", end: "02:00" }],
          inactive: [],
          activeEnabled: true,
          inactiveEnabled: false,
        },
      }],
    };

    expect(getComboModelsFromData("night-only", [combo], new Date("2026-08-19T02:30:00Z"))).toEqual([]);
  });

  it("normalizes valid nodes, canonicalizes legacy schedules, and rejects invalid ones", () => {
    expect(normalizeComboModelsForStorage([
      "plain/model",
      { model: "legacy/model", schedule: { start: "09:00", end: "18:00", timezone: "Asia/Shanghai" } },
      {
        model: "multi/model",
        schedule: {
          timezone: "UTC",
          active: [{ start: "09:00", end: "12:00" }, { start: "14:00", end: "18:00" }],
          inactive: [{ start: "12:00", end: "14:00" }],
          activeEnabled: true,
          inactiveEnabled: true,
        },
      },
      { model: "no-schedule/model" },
    ])).toEqual([
      "plain/model",
      {
        model: "legacy/model",
        schedule: {
          timezone: "Asia/Shanghai",
          active: [{ start: "09:00", end: "18:00" }],
          inactive: [],
          activeEnabled: true,
          inactiveEnabled: false,
        },
      },
      {
        model: "multi/model",
        schedule: {
          timezone: "UTC",
          active: [{ start: "09:00", end: "12:00" }, { start: "14:00", end: "18:00" }],
          inactive: [{ start: "12:00", end: "14:00" }],
          activeEnabled: true,
          inactiveEnabled: true,
        },
      },
      "no-schedule/model",
    ]);

    expect(normalizeComboModelsForStorage([
      { model: "bad/model", schedule: { active: [{ start: "9:00", end: "18:00" }] } },
    ])).toBeNull();
    expect(normalizeComboModelsForStorage([
      { model: "zero/model", schedule: { active: [{ start: "09:00", end: "09:00" }] } },
    ])).toBeNull();
    expect(normalizeComboModelsForStorage([
      {
        model: "duplicate/model",
        schedule: {
          active: [{ start: "09:00", end: "10:00" }, { start: "09:00", end: "10:00" }],
        },
      },
    ])).toBeNull();
  });
});
