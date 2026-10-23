import { describe, it, expect } from "vitest";

import {
  TEMPLATE_KINDS,
  buildTemplateMembers,
  getTemplateLabel,
  strengthScore,
  cheapnessScore,
  templateComboName,
} from "../../src/shared/utils/comboTemplates.js";

function model(provider, name, { reasoning = true, input = 1, output = 3, contextWindow = 128000 } = {}) {
  return {
    provider,
    model: name,
    fullModel: `${provider}/${name}`,
    caps: { reasoning, tools: true, contextWindow },
    pricing: { input, output },
  };
}

const catalog = [
  model("acme", "acme-opus", { input: 15, output: 75 }),
  model("acme", "acme-flash", { input: 0.1, output: 0.4 }),
  model("beta", "beta-sol", { input: 5, output: 20 }),
  model("gamma", "gamma-pro", { input: 2, output: 8 }),
  // Not a chat model: must never enter a routing group.
  { ...model("acme", "acme-voice"), caps: { audioOutput: true } },
];

describe("template kinds", () => {
  it("each kind has a label and a summary", () => {
    for (const kind of TEMPLATE_KINDS) {
      const label = getTemplateLabel(kind);
      expect(label?.name).toBeTruthy();
      expect(label?.summary).toBeTruthy();
    }
    expect(getTemplateLabel("nope")).toBeNull();
  });
});

describe("smart template", () => {
  it("puts the strongest model first and a genuinely cheaper one behind it", () => {
    const { members, need } = buildTemplateMembers("smart", catalog);
    expect(need).toBeNull();
    expect(members).toHaveLength(2);
    expect(members[0].model).toBe("acme/acme-opus");
    expect(members[0].autoTier).toBe("strong");
    expect(members[1].model).toBe("acme/acme-flash");
    expect(members[1].autoTier).toBe("fast");
  });

  it("refuses when nothing is cheaper than the strongest pick", () => {
    // Only one model, so there is no second, cheaper choice to make.
    const { members, need, of } = buildTemplateMembers("smart", [model("acme", "acme-opus")]);
    expect(members).toEqual([]);
    expect(need).toBe("cheap");
    expect(of).toBe("acme/acme-opus");
  });

  it("does not accept an equal-priced model as the cheap member", () => {
    const flat = [
      model("acme", "acme-opus", { input: 5, output: 20 }),
      model("acme", "acme-other", { input: 5, output: 20 }),
    ];
    expect(buildTemplateMembers("smart", flat).need).toBe("cheap");
  });
});

describe("thrifty template", () => {
  it("starts cheap and keeps a dearer reasoning model as the fallback", () => {
    const { members, need } = buildTemplateMembers("thrifty", catalog);
    expect(need).toBeNull();
    expect(members[0].model).toBe("acme/acme-flash");
    expect(members[0].autoTier).toBe("fast");
    expect(members[1].autoTier).toBe("strong");
    expect(members[1].model).not.toBe(members[0].model);
    // The fallback must be a real upgrade, so it has to cost more.
    const cheap = cheapnessScore(catalog.find((m) => m.model === "acme-flash"));
    const fallback = cheapnessScore(catalog.find((m) => m.model === members[1].model.split("/")[1]));
    expect(fallback).toBeGreaterThan(cheap);
  });

  it("degrades to just the cheap pick when nothing better exists", () => {
    const only = [model("acme", "acme-flash", { input: 0.1, output: 0.4 })];
    const { members, need } = buildTemplateMembers("thrifty", only);
    expect(need).toBeNull();
    expect(members).toHaveLength(1);
  });
});

describe("steady template", () => {
  it("takes one strongest model per provider", () => {
    const { members, need } = buildTemplateMembers("steady", catalog);
    expect(need).toBeNull();
    const providers = members.map((m) => m.model.split("/")[0]);
    expect(new Set(providers).size).toBe(providers.length);
    expect(providers).toHaveLength(3);
    // Strongest provider first.
    expect(members[0].model).toBe("acme/acme-opus");
  });

  it("explains when only one provider is connected", () => {
    const single = [
      model("acme", "acme-opus"),
      model("acme", "acme-flash"),
    ];
    const { members, need, of } = buildTemplateMembers("steady", single);
    expect(members).toEqual([]);
    expect(need).toBe("providers");
    expect(of).toBe("acme");
  });

  it("caps at three members", () => {
    const many = ["a", "b", "c", "d", "e"].map((p) => model(p, `${p}-top`));
    expect(buildTemplateMembers("steady", many).members).toHaveLength(3);
  });

  it("writes no tier, because 'balanced' is already the default", () => {
    // A stored default is noise, and the combo UI collapses it back to a string.
    const members = buildTemplateMembers("steady", catalog).members;
    expect(members.every((m) => m.autoTier === undefined)).toBe(true);
  });
});

describe("tier output", () => {
  it("only ever emits non-default tiers", () => {
    for (const kind of TEMPLATE_KINDS) {
      for (const member of buildTemplateMembers(kind, catalog).members) {
        expect([undefined, "strong", "fast"]).toContain(member.autoTier);
        expect(member.autoTier).not.toBe("balanced");
      }
    }
  });
});

describe("candidate filtering", () => {
  it("never picks a voice or image model", () => {
    for (const kind of TEMPLATE_KINDS) {
      const members = buildTemplateMembers(kind, catalog).members;
      expect(members.some((m) => m.model.includes("voice"))).toBe(false);
    }
  });

  it("reports 'any' when nothing is connected", () => {
    const { members, need } = buildTemplateMembers("smart", []);
    expect(members).toEqual([]);
    expect(need).toBe("any");
  });

  it("survives junk input", () => {
    expect(buildTemplateMembers("smart", null).need).toBe("any");
    expect(buildTemplateMembers("smart", [{}, null, { model: "x" }]).need).toBe("any");
  });
});

describe("scoring", () => {
  it("ranks a reasoning model above a non-reasoning one", () => {
    const a = model("p", "p-model", { reasoning: true });
    const b = model("p", "p-model", { reasoning: false });
    expect(strengthScore(a)).toBeGreaterThan(strengthScore(b));
  });

  it("treats unknown pricing as not cheap, and zero as genuinely free", () => {
    expect(cheapnessScore({ model: "x" })).toBe(Number.POSITIVE_INFINITY);
    // A free model is the cheapest thing there is, not an unknown price.
    expect(cheapnessScore({ pricing: { input: 0, output: 0 } })).toBe(0);
    expect(cheapnessScore({ pricing: { input: 1, output: 1 } })).toBeGreaterThan(0);
    // Missing one side still yields a usable blend.
    expect(cheapnessScore({ pricing: { input: null, output: 3 } })).toBe(1);
  });

  it("prefers a free model over a paid one in a cheap-slot template", () => {
    const free = { ...model("acme", "acme-free"), pricing: { input: 0, output: 0 } };
    const { members } = buildTemplateMembers("smart", [...catalog, free]);
    expect(members[1].model).toBe("acme/acme-free");
  });
});

describe("template names", () => {
  it("avoids collisions rather than overwriting a combo", () => {
    expect(templateComboName("smart", [])).toBe("tpl-smart");
    expect(templateComboName("smart", ["tpl-smart"])).toBe("tpl-smart-2");
    expect(templateComboName("smart", ["tpl-smart", "tpl-smart-2"])).toBe("tpl-smart-3");
  });
});
