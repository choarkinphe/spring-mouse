import { describe, it, expect } from "vitest";

import migration from "../../src/lib/db/migrations/026-combo-strategy-by-id.js";
import {
  getComboStrategy,
  comboStrategyKey,
  remapComboStrategyKeys,
} from "../../open-sse/services/comboStrategy.js";

// A minimal adapter: `get` returns the settings row, `all` the combos.
function makeDb(settings, combos) {
  let data = JSON.stringify(settings);
  return {
    get: () => ({ data }),
    all: () => combos,
    run: (_sql, params) => { data = params[0]; },
    read: () => JSON.parse(data),
  };
}

describe("combo strategy keyed by id", () => {
  it("moves name keys onto the combo id", () => {
    const combos = [{ id: "c1", name: "fast" }, { id: "c2", name: "slow" }];
    const db = makeDb({
      comboStrategies: {
        fast: { fallbackStrategy: "fusion", judgeModel: "judge/model" },
        slow: { fallbackStrategy: "auto" },
      },
      unrelated: true,
    }, combos);

    migration.up(db);
    const after = db.read();

    expect(after.comboStrategies).toEqual({
      c1: { fallbackStrategy: "fusion", judgeModel: "judge/model" },
      c2: { fallbackStrategy: "auto" },
    });
    expect(after.comboStrategies.fast).toBeUndefined();
    expect(after.unrelated).toBe(true);
  });

  it("leaves an already-id-keyed row untouched (no write on upgrade)", () => {
    const combos = [{ id: "c1", name: "fast" }];
    const original = { comboStrategies: { c1: { fallbackStrategy: "fusion" } } };
    const db = makeDb(original, combos);
    let wrote = false;
    const realRun = db.run;
    db.run = (...args) => { wrote = true; return realRun(...args); };

    migration.up(db);

    expect(wrote).toBe(false);
  });

  it("preserves a strategy whose combo no longer exists", () => {
    const db = makeDb({
      comboStrategies: { ghost: { fallbackStrategy: "round-robin" } },
    }, [{ id: "c1", name: "fast" }]);

    migration.up(db);

    expect(db.read().comboStrategies).toEqual({ ghost: { fallbackStrategy: "round-robin" } });
  });

  it("keeps the id-keyed entry when a stale name key points at the same combo", () => {
    const combos = [{ id: "c1", name: "fast" }];
    const db = makeDb({
      comboStrategies: {
        fast: { fallbackStrategy: "fallback" },
        c1: { fallbackStrategy: "fusion" },
      },
    }, combos);

    migration.up(db);

    // The id key is authoritative; the stale name duplicate does not overwrite it.
    expect(db.read().comboStrategies).toEqual({ c1: { fallbackStrategy: "fusion" } });
  });

  it("survives a malformed settings row without touching it", () => {
    const db = {
      get: () => ({ data: "{not json" }),
      all: () => [],
      run: () => { throw new Error("must not write"); },
    };

    expect(() => migration.up(db)).not.toThrow();
  });
});

describe("getComboStrategy", () => {
  const combo = { id: "c1", name: "fast" };

  it("prefers the id key", () => {
    const strategies = { c1: { fallbackStrategy: "fusion" }, fast: { fallbackStrategy: "auto" } };
    expect(getComboStrategy(strategies, combo)).toEqual({ fallbackStrategy: "fusion" });
  });

  it("reads a legacy name key so an un-migrated row keeps working", () => {
    expect(getComboStrategy({ fast: { fallbackStrategy: "fusion" } }, combo))
      .toEqual({ fallbackStrategy: "fusion" });
  });

  it("returns an empty object for an unknown combo", () => {
    expect(getComboStrategy({ c1: { fallbackStrategy: "fusion" } }, { id: "c9", name: "other" })).toEqual({});
    expect(getComboStrategy(null, combo)).toEqual({});
    expect(getComboStrategy({}, null)).toEqual({});
  });

  it("keys writes by id, falling back to name only for an unsaved combo", () => {
    expect(comboStrategyKey(combo)).toBe("c1");
    expect(comboStrategyKey({ name: "draft" })).toBe("draft");
    expect(comboStrategyKey(null)).toBe("");
  });
});

describe("remapComboStrategyKeys", () => {
  it("is idempotent", () => {
    const combos = [{ id: "c1", name: "fast" }];
    const once = remapComboStrategyKeys({ fast: { fallbackStrategy: "fusion" } }, combos);
    expect(remapComboStrategyKeys(once, combos)).toEqual(once);
  });

  it("does not confuse a combo name that looks like another combo's id", () => {
    const combos = [{ id: "fast", name: "renamed" }, { id: "c2", name: "fast" }];
    // The key "fast" is already a live id, so it must stay that id rather than
    // being remapped to c2 by name.
    expect(remapComboStrategyKeys({ fast: { fallbackStrategy: "fusion" } }, combos))
      .toEqual({ fast: { fallbackStrategy: "fusion" } });
  });
});
