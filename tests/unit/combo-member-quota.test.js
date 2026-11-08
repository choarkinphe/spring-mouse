import { describe, expect, it } from "vitest";
import { comboModelEntry, normalizeMemberQuota } from "open-sse/services/combo.js";
import {
  buildMemberQuotaCounters,
  buildMemberQuotaStatus,
  collectMemberQuotaTargets,
  memberQuotaScope,
  readMemberUsageTotals,
} from "@/lib/memberQuota.js";
import { isComboOnlyKey, normalizeComboOnlyRouting } from "@/shared/utils/comboOnlyRouting.js";

// `cx` is an alias of `codex`; everything else resolves to itself.
const ALIASES = { cx: "codex" };
const resolve = async (memberId) => {
  const slash = memberId.indexOf("/");
  const prefix = memberId.slice(0, slash);
  return { provider: ALIASES[prefix] || prefix, model: memberId.slice(slash + 1) };
};

describe("normalizeMemberQuota", () => {
  it("keeps positive finite limits rounded to 3 decimals", () => {
    expect(normalizeMemberQuota({ fiveHourTokenLimitM: "1.23456", weeklyTokenLimitM: 10 }))
      .toEqual({ fiveHourTokenLimitM: 1.235, weeklyTokenLimitM: 10 });
  });

  it("drops non-positive and invalid values, and returns null when nothing is left", () => {
    expect(normalizeMemberQuota({ fiveHourTokenLimitM: 0, weeklyTokenLimitM: "abc" })).toBeNull();
    expect(normalizeMemberQuota({ fiveHourTokenLimitM: -1, weeklyTokenLimitM: 5 })).toEqual({ weeklyTokenLimitM: 5 });
    expect(normalizeMemberQuota(null)).toBeNull();
    expect(normalizeMemberQuota("5")).toBeNull();
  });

  it("is exposed on the parsed combo entry", () => {
    expect(comboModelEntry({ model: "cx/gpt-5", quota: { weeklyTokenLimitM: 2 } }).quota).toEqual({ weeklyTokenLimitM: 2 });
    expect(comboModelEntry("cx/gpt-5").quota).toBeNull();
  });
});

describe("collectMemberQuotaTargets", () => {
  it("shares one counter across combos and aliases, with the tighter limit winning", async () => {
    const combos = [
      { name: "premium", models: [{ model: "cx/gpt-5", quota: { fiveHourTokenLimitM: 5, weeklyTokenLimitM: 20 } }, "glm/glm-5"] },
      { name: "coding", models: [{ model: "codex/gpt-5", quota: { fiveHourTokenLimitM: 2 } }] },
    ];
    const { targets, memberToTarget } = await collectMemberQuotaTargets(combos, resolve);

    expect([...targets.keys()]).toEqual(["codex/gpt-5"]);
    const target = targets.get("codex/gpt-5");
    expect(target.fiveHourTokenLimitM).toBe(2);
    expect(target.weeklyTokenLimitM).toBe(20);
    expect(target.combos).toEqual(["premium", "coding"]);
    expect(memberToTarget.get("cx/gpt-5")).toBe("codex/gpt-5");
    expect(memberToTarget.get("codex/gpt-5")).toBe("codex/gpt-5");
    expect(memberToTarget.has("glm/glm-5")).toBe(false);
  });

  it("maps an alias without its own quota onto a quota'd target", async () => {
    const combos = [
      { name: "a", models: [{ model: "codex/gpt-5", quota: { weeklyTokenLimitM: 1 } }] },
      { name: "b", models: ["cx/gpt-5"] },
    ];
    const { memberToTarget } = await collectMemberQuotaTargets(combos, resolve);
    expect(memberToTarget.get("cx/gpt-5")).toBe("codex/gpt-5");
  });

  it("ignores inactive combos, sub-combo members and failing resolution", async () => {
    const combos = [
      { name: "off", isActive: false, models: [{ model: "cx/gpt-5", quota: { weeklyTokenLimitM: 1 } }] },
      { name: "nested", models: [{ model: "premium", quota: { weeklyTokenLimitM: 1 } }] },
      { name: "broken", models: [{ model: "bad/model", quota: { weeklyTokenLimitM: 1 } }] },
    ];
    const failing = async (id) => {
      if (id.startsWith("bad/")) throw new Error("boom");
      return resolve(id);
    };
    const { targets } = await collectMemberQuotaTargets(combos, failing);
    expect(targets.size).toBe(0);
  });
});

describe("member quota status and counters", () => {
  const target = {
    id: "codex/gpt-5",
    label: "cx/gpt-5",
    provider: "codex",
    model: "gpt-5",
    members: ["cx/gpt-5"],
    combos: ["premium"],
    fiveHourTokenLimitM: 1,
    weeklyTokenLimitM: null,
  };

  it("flags the window whose limit is reached", () => {
    const status = buildMemberQuotaStatus(target, {
      fiveHour: { usedTokens: 1_000_000, nextResetAt: "2026-11-08T05:00:00.000Z" },
      weekly: { usedTokens: 5_000_000 },
    });
    expect(status.exceededWindow?.id).toBe("fiveHour");
    expect(status.windows.find((w) => w.id === "weekly").exceeded).toBe(false);
  });

  it("is not exhausted below the limit", () => {
    expect(buildMemberQuotaStatus(target, { fiveHour: { usedTokens: 999_999 } }).exceededWindow).toBeNull();
  });

  it("charges only the model that actually ran, only for limited windows", () => {
    const targets = new Map([[target.id, target]]);
    const key = { id: "k1", fiveHourQuotaResetAt: "2026-11-08T05:00:00.000Z", weeklyQuotaResetAt: "2026-11-15T00:00:00.000Z" };

    expect(buildMemberQuotaCounters({ key, provider: "codex", model: "gpt-5", tokens: 100, targets })).toEqual([
      { scope: memberQuotaScope("codex/gpt-5"), windowId: "fiveHour", resetAt: key.fiveHourQuotaResetAt, delta: 100 },
    ]);
    expect(buildMemberQuotaCounters({ key, provider: "glm", model: "glm-5", tokens: 100, targets })).toEqual([]);
    expect(buildMemberQuotaCounters({ key, provider: "codex", model: "gpt-5", tokens: 0, targets })).toEqual([]);
  });

  it("encodes the scope so a model id cannot forge a key segment", () => {
    expect(memberQuotaScope("p/a:b")).toBe("member:p%2Fa%3Ab");
  });

  it("seeds totals from one grouped usage scan", () => {
    const db = {
      all: () => [
        { provider: "codex", model: "gpt-5", usedTokens: 300 },
        { provider: "glm", model: "glm-5", usedTokens: 900 },
      ],
    };
    const totals = readMemberUsageTotals(
      db,
      "k1",
      { id: "fiveHour", durationMs: 5 * 60 * 60 * 1000 },
      "2026-11-08T05:00:00.000Z",
      ["codex/gpt-5", "x/y"],
    );
    expect(Object.fromEntries(totals)).toEqual({ "codex/gpt-5": 300, "x/y": 0 });
  });
});

describe("combo-only routing", () => {
  it("defaults to disabled with god/sys exempt", () => {
    expect(normalizeComboOnlyRouting(undefined)).toEqual({ enabled: false, exemptTags: ["god", "sys"] });
    expect(normalizeComboOnlyRouting({ enabled: "yes" }).enabled).toBe(false);
  });

  it("keeps an explicitly empty exempt list", () => {
    expect(normalizeComboOnlyRouting({ enabled: true, exemptTags: [] })).toEqual({ enabled: true, exemptTags: [] });
  });

  it("restricts only non-exempt keys while enabled", () => {
    const settings = { comboOnlyRouting: { enabled: true, exemptTags: ["god", "sys"] } };
    expect(isComboOnlyKey(settings, ["staff"])).toBe(true);
    expect(isComboOnlyKey(settings, [])).toBe(true);
    expect(isComboOnlyKey(settings, ["staff", "god"])).toBe(false);
    expect(isComboOnlyKey({ comboOnlyRouting: { enabled: false } }, ["staff"])).toBe(false);
    expect(isComboOnlyKey({}, ["staff"])).toBe(false);
  });
});
