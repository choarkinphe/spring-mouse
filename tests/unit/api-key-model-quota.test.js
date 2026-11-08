import { describe, expect, it } from "vitest";
import {
  buildModelQuotaCounters,
  buildModelQuotaGroupStatus,
  findModelQuotaGroup,
  modelMatchesGroup,
  normalizeModelQuotaOverrides,
  normalizeModelQuotaRules,
  readModelGroupUsageTotals,
  resolveModelQuotaGroups,
} from "@/lib/apiKeyModelQuota";
import { quotaCounterKey } from "@/lib/redis/liveUsage";

const RULES = {
  enabled: true,
  groups: [
    {
      id: "premium",
      label: "高阶模型",
      models: ["claude-opus*", "gpt-5*"],
      fiveHourTokenLimitM: 2,
      weeklyTokenLimitM: 20,
      fallback: "anthropic/claude-sonnet-4-5",
    },
    {
      id: "mid",
      label: "中阶模型",
      models: ["claude-sonnet*"],
      fiveHourTokenLimitM: 10,
      weeklyTokenLimitM: 100,
    },
  ],
};

const KEY = {
  id: "key-1",
  fiveHourQuotaResetAt: "2026-11-08T05:00:00.000Z",
  weeklyQuotaResetAt: "2026-11-15T00:00:00.000Z",
};

describe("model quota rules", () => {
  it("normalizes groups, deriving stable ids and lowercasing patterns", () => {
    const rules = normalizeModelQuotaRules({
      groups: [
        { label: "高阶 模型", models: ["Claude-Opus*", " claude-opus* "], fiveHourTokenLimitM: "2", weeklyTokenLimitM: -1 },
      ],
    });
    expect(rules.enabled).toBe(true);
    expect(rules.groups).toHaveLength(1);
    expect(rules.groups[0]).toMatchObject({
      label: "高阶 模型",
      models: ["claude-opus*"],
      fiveHourTokenLimitM: 2,
      weeklyTokenLimitM: null,
      enabled: true,
    });
  });

  // Counter keys embed the group id, so an id that moved when the list was
  // reordered would reset that group's usage on the next dashboard save.
  it("derives an id that survives reordering even for a non-ASCII label", () => {
    const a = normalizeModelQuotaRules({ groups: [{ label: "高阶模型", models: ["x"], fiveHourTokenLimitM: 1 }, { label: "中阶模型", models: ["y"], fiveHourTokenLimitM: 1 }] });
    const b = normalizeModelQuotaRules({ groups: [{ label: "中阶模型", models: ["y"], fiveHourTokenLimitM: 1 }, { label: "高阶模型", models: ["x"], fiveHourTokenLimitM: 1 }] });
    const idOf = (rules, label) => rules.groups.find((group) => group.label === label).id;
    expect(idOf(a, "高阶模型")).toBe(idOf(b, "高阶模型"));
    expect(idOf(a, "高阶模型")).not.toBe(idOf(a, "中阶模型"));
    expect(idOf(a, "高阶模型")).toMatch(/^[a-z0-9][a-z0-9_-]{0,47}$/i);
  });

  it("drops duplicate ids instead of letting two groups share a counter", () => {
    const rules = normalizeModelQuotaRules({
      groups: [
        { id: "dup", models: ["a"], fiveHourTokenLimitM: 1 },
        { id: "dup", models: ["b"], fiveHourTokenLimitM: 2 },
      ],
    });
    expect(rules.groups).toHaveLength(1);
    expect(rules.groups[0].models).toEqual(["a"]);
  });

  it("ignores junk rules without throwing", () => {
    expect(normalizeModelQuotaRules(null)).toEqual({ enabled: true, groups: [] });
    expect(normalizeModelQuotaRules({ groups: "nope" })).toEqual({ enabled: true, groups: [] });
    expect(normalizeModelQuotaRules({ groups: [null, 5, "x"] })).toEqual({ enabled: true, groups: [] });
  });
});

describe("model group matching", () => {
  const [premium] = resolveModelQuotaGroups(RULES, KEY);

  it("matches bare ids, case-insensitively, through the wildcard", () => {
    expect(modelMatchesGroup(premium, { provider: "anthropic", model: "Claude-Opus-5" })).toBe(true);
    expect(modelMatchesGroup(premium, { provider: "openai", model: "gpt-5.1" })).toBe(true);
  });

  it("matches provider/model so a group can be scoped to one deployment", () => {
    const scoped = normalizeModelQuotaRules({
      groups: [{ label: "azure", models: ["azure/gpt-5*"], fiveHourTokenLimitM: 1 }],
    }).groups[0];
    expect(modelMatchesGroup(scoped, { provider: "azure", model: "gpt-5" })).toBe(true);
    expect(modelMatchesGroup(scoped, { provider: "openai", model: "gpt-5" })).toBe(false);
  });

  it("does not leak regex syntax: a stray bracket is a literal", () => {
    const group = normalizeModelQuotaRules({
      groups: [{ label: "odd", models: ["claude-[opus"], fiveHourTokenLimitM: 1 }],
    }).groups[0];
    expect(modelMatchesGroup(group, { model: "claude-[opus" })).toBe(true);
    expect(modelMatchesGroup(group, { model: "claude-o" })).toBe(false);
  });

  it("returns the first claiming group, so order is the tie-break", () => {
    const groups = resolveModelQuotaGroups(RULES, KEY);
    expect(findModelQuotaGroup(groups, { provider: "anthropic", model: "claude-opus-5" }).id).toBe("premium");
    expect(findModelQuotaGroup(groups, { provider: "anthropic", model: "claude-sonnet-4-5" }).id).toBe("mid");
    expect(findModelQuotaGroup(groups, { provider: "anthropic", model: "claude-haiku-4" })).toBeNull();
  });
});

describe("per-key overrides", () => {
  it("applies limits, fallback and enabled per key", () => {
    const groups = resolveModelQuotaGroups(RULES, {
      ...KEY,
      modelQuotaOverrides: { premium: { fiveHourTokenLimitM: 0.5, fallback: "anthropic/claude-haiku-4" } },
    });
    const premium = groups.find((group) => group.id === "premium");
    expect(premium.fiveHourTokenLimitM).toBe(0.5);
    expect(premium.weeklyTokenLimitM).toBe(20);
    expect(premium.fallback).toBe("anthropic/claude-haiku-4");
  });

  it("clears an override with an explicit null", () => {
    const groups = resolveModelQuotaGroups(RULES, {
      ...KEY,
      modelQuotaOverrides: { mid: { fiveHourTokenLimitM: null } },
    });
    expect(groups.find((group) => group.id === "mid").fiveHourTokenLimitM).toBeNull();
  });

  it("drops a group disabled for this key", () => {
    const groups = resolveModelQuotaGroups(RULES, {
      ...KEY,
      modelQuotaOverrides: { premium: { enabled: false } },
    });
    expect(groups.map((group) => group.id)).toEqual(["mid"]);
  });

  it("ignores overrides for unknown or malformed group ids", () => {
    expect(normalizeModelQuotaOverrides({ "bad id!": { fiveHourTokenLimitM: 1 }, premium: "x" })).toEqual({});
  });

  it("accepts the stored JSON form", () => {
    const groups = resolveModelQuotaGroups(RULES, {
      ...KEY,
      modelQuotaOverrides: JSON.stringify({ premium: { weeklyTokenLimitM: 5 } }),
    });
    expect(groups.find((group) => group.id === "premium").weeklyTokenLimitM).toBe(5);
  });
});

describe("model quota counters", () => {
  it("charges every limited window of the claiming group", () => {
    const counters = buildModelQuotaCounters({
      key: { ...KEY, modelQuotaRules: RULES },
      provider: "anthropic",
      model: "claude-opus-5",
      tokens: 1_000_000,
    });
    expect(counters).toEqual([
      { scope: "model:premium", windowId: "fiveHour", resetAt: KEY.fiveHourQuotaResetAt, delta: 1_000_000 },
      { scope: "model:premium", windowId: "weekly", resetAt: KEY.weeklyQuotaResetAt, delta: 1_000_000 },
    ]);
    expect(quotaCounterKey("key-1", "fiveHour", KEY.fiveHourQuotaResetAt, counters[0].scope))
      .toBe(`spring-mouse:quota:key-1:model:premium:fiveHour:${KEY.fiveHourQuotaResetAt}`);
  });

  it("charges a model claimed by no group nothing", () => {
    expect(buildModelQuotaCounters({
      key: { ...KEY, modelQuotaRules: RULES },
      provider: "anthropic",
      model: "claude-haiku-4",
      tokens: 1000,
    })).toEqual([]);
  });

  it("charges nothing for a zero-token or unknown key", () => {
    expect(buildModelQuotaCounters({ key: { ...KEY, modelQuotaRules: RULES }, provider: "anthropic", model: "claude-opus-5", tokens: 0 })).toEqual([]);
    expect(buildModelQuotaCounters({ key: null, provider: "anthropic", model: "claude-opus-5", tokens: 10 })).toEqual([]);
  });

  it("charges a downgraded request against the model that actually ran", () => {
    const counters = buildModelQuotaCounters({
      key: { ...KEY, modelQuotaRules: RULES },
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      tokens: 10,
    });
    expect(counters.map((counter) => counter.scope)).toEqual(["model:mid", "model:mid"]);
  });
});

describe("model group status", () => {
  const [premium] = resolveModelQuotaGroups(RULES, KEY);

  it("marks a window exceeded at exactly its limit", () => {
    const status = buildModelQuotaGroupStatus(premium, {
      fiveHour: { usedTokens: 2_000_000, nextResetAt: KEY.fiveHourQuotaResetAt },
      weekly: { usedTokens: 1_000_000, nextResetAt: KEY.weeklyQuotaResetAt },
    });
    expect(status.exceededWindow.id).toBe("fiveHour");
    expect(status.windows[0]).toMatchObject({ usedM: 2, remainingM: 0, usedPercentage: 100, exceeded: true });
    expect(status.windows[1]).toMatchObject({ usedM: 1, exceeded: false, usedPercentage: 5 });
  });

  it("reports no exceeded window when usage is absent", () => {
    const status = buildModelQuotaGroupStatus(premium);
    expect(status.exceededWindow).toBeNull();
    expect(status.windows.every((window) => window.resetAt === null)).toBe(true);
  });
});

describe("cold-cache seeding", () => {
  // A minimal adapter: the query shape is the contract this reads through.
  const dbWindow = ({ rows }) => ({
    all(sql) {
      expect(sql).toContain("GROUP BY provider, model");
      return rows;
    },
  });

  it("aggregates per group from one grouped scan", () => {
    const groups = resolveModelQuotaGroups(RULES, KEY);
    const totals = readModelGroupUsageTotals(
      dbWindow({
        rows: [
          { provider: "anthropic", model: "claude-opus-5", usedTokens: 1_500_000 },
          { provider: "anthropic", model: "claude-sonnet-4-5", usedTokens: 700_000 },
          { provider: "openai", model: "gpt-5", usedTokens: 250_000 },
          { provider: "anthropic", model: "claude-haiku-4", usedTokens: 90_000 },
        ],
      }),
      "key-1",
      { id: "fiveHour", durationMs: 5 * 60 * 60 * 1000 },
      KEY.fiveHourQuotaResetAt,
      groups,
    );
    expect(totals.get("premium")).toBe(1_750_000);
    expect(totals.get("mid")).toBe(700_000);
  });
});
