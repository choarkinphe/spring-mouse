import { describe, it, expect } from "vitest";
import {
  BUILTIN_HARNESSES,
  HARNESS_MODEL_OPTIONS,
  resolveHarnessPrefix,
  matchHarnessMapping,
  isValidHarnessMatch,
  isValidHarnessTarget,
  normalizeHarnessProfiles,
  normalizeHarnessModels,
  resolveHarnessModelOptions,
  resolveHarnessProfiles,
  resolveHarnessTarget,
} from "../../src/shared/utils/harnessRoute.js";

const URL_FOR = (path) => `https://mass.example.com${path}`;

describe("harness prefix resolution", () => {
  it("reads the harness from the first path segment", () => {
    expect(resolveHarnessPrefix(URL_FOR("/claude-desktop/v1/messages"))).toBe("claude-desktop");
    expect(resolveHarnessPrefix(URL_FOR("/claude-code/v1/messages"))).toBe("claude-code");
    expect(resolveHarnessPrefix(URL_FOR("/codex/v1/responses"))).toBe("codex");
  });

  it("returns null for the bare API and unknown prefixes", () => {
    expect(resolveHarnessPrefix(URL_FOR("/v1/messages"))).toBeNull();
    expect(resolveHarnessPrefix(URL_FOR("/api/v1/messages"))).toBeNull();
    expect(resolveHarnessPrefix(URL_FOR("/v1/v1/messages"))).toBeNull();
    expect(resolveHarnessPrefix(URL_FOR("/unknown/v1/messages"))).toBeNull();
    expect(resolveHarnessPrefix("not-a-url")).toBeNull();
  });

  it("lists exactly the three built-in harnesses wired in next.config.mjs", () => {
    expect(BUILTIN_HARNESSES.map((item) => item.prefix)).toEqual([
      "claude-desktop",
      "claude-code",
      "codex",
    ]);
  });
});

describe("mapping match", () => {
  const mappings = [
    { match: "claude-*", target: "glm-5.2" },
    { match: "claude-opus-*", target: "cx/gpt-5.6-sol" },
    { match: "claude-sonnet-4-5", target: "exact/winner" },
  ];

  it("prefers an exact match over wildcards", () => {
    expect(matchHarnessMapping("claude-sonnet-4-5", mappings)).toBe("exact/winner");
  });

  it("prefers the longest wildcard literal", () => {
    expect(matchHarnessMapping("claude-opus-5", mappings)).toBe("cx/gpt-5.6-sol");
    expect(matchHarnessMapping("claude-haiku-4-5", mappings)).toBe("glm-5.2");
  });

  it("supports suffix wildcards and returns null when nothing matches", () => {
    expect(matchHarnessMapping("gpt-5-preview", [{ match: "*-preview", target: "p/x" }])).toBe("p/x");
    expect(matchHarnessMapping("gemini-2", mappings)).toBeNull();
    expect(matchHarnessMapping("", mappings)).toBeNull();
    expect(matchHarnessMapping("claude-opus-5", null)).toBeNull();
  });

  it("ignores entries with a blank match or target", () => {
    expect(matchHarnessMapping("claude-opus-5", [
      { match: "claude-opus-*", target: "" },
      { match: "", target: "p/x" },
    ])).toBeNull();
  });

  it("rejects an interior wildcard rather than guessing", () => {
    expect(matchHarnessMapping("claude-4-5", [{ match: "claude-*-4-5", target: "p/x" }])).toBeNull();
  });
});

describe("value validation", () => {
  it("accepts provider/model and bare combo targets", () => {
    expect(isValidHarnessTarget("cx/gpt-5.6-sol")).toBe(true);
    expect(isValidHarnessTarget("deepseek-flash")).toBe(true);
    expect(isValidHarnessTarget("/leading")).toBe(false);
    expect(isValidHarnessTarget("trailing/")).toBe(false);
    expect(isValidHarnessTarget("has space")).toBe(false);
    expect(isValidHarnessTarget("")).toBe(false);
  });

  it("accepts a single leading or trailing wildcard only", () => {
    expect(isValidHarnessMatch("claude-opus-*")).toBe(true);
    expect(isValidHarnessMatch("*-preview")).toBe(true);
    expect(isValidHarnessMatch("claude-4-5")).toBe(true);
    expect(isValidHarnessMatch("claude-*-4-5")).toBe(false);
    expect(isValidHarnessMatch("has space*")).toBe(false);
  });
});

describe("normalizeHarnessProfiles", () => {
  it("keeps known prefixes and drops unknown ones", () => {
    const result = normalizeHarnessProfiles({
      "claude-code": { enabled: true, mappings: [{ match: "claude-*", target: "glm-5.2" }] },
      "not-a-harness": { enabled: true, mappings: [{ match: "x", target: "y" }] },
    });
    expect(Object.keys(result)).toEqual(["claude-code"]);
    expect(result["claude-code"].mappings).toEqual([{ match: "claude-*", target: "glm-5.2" }]);
  });

  it("drops invalid mappings instead of throwing", () => {
    const result = normalizeHarnessProfiles({
      codex: {
        enabled: true,
        mappings: [
          { match: "gpt-*", target: "cx/gpt-5.6-sol" },
          { match: "", target: "p/x" },
          { match: "gpt-*", target: "" },
          { match: "gpt-*-x", target: "p/x" },
        ],
      },
    });
    expect(result.codex.mappings).toEqual([{ match: "gpt-*", target: "cx/gpt-5.6-sol" }]);
  });

  it("defaults a missing label to the built-in name and enabled to true", () => {
    const result = normalizeHarnessProfiles({ codex: { mappings: [] } });
    expect(result.codex).toEqual({ enabled: true, label: "Codex", mappings: [] });
  });

  it("treats null as empty and rejects non-objects", () => {
    expect(normalizeHarnessProfiles(null)).toEqual({});
    expect(() => normalizeHarnessProfiles("nope")).toThrow();
    expect(() => normalizeHarnessProfiles([])).toThrow();
  });
});

describe("operator-maintained model ids", () => {
  it("keeps known prefixes and drops duplicates against the built-ins", () => {
    const result = normalizeHarnessModels({
      "claude-code": ["claude-opus-next", "claude-opus-4-6", "claude-opus-next", "  claude-sonnet-4-5  "],
      "not-a-harness": ["whatever"],
    });
    // A built-in is dropped, while a repeated custom id is kept once.
    expect(Object.keys(result)).toEqual(["claude-code"]);
    expect(result["claude-code"]).toEqual(["claude-opus-next", "claude-sonnet-4-5"]);
  });

  it("drops invalid ids and omits empty lists", () => {
    const result = normalizeHarnessModels({
      codex: ["gpt-5.6", "has space", "claude-*-4-5", ""],
      "claude-code": [],
    });
    expect(result.codex).toEqual(["gpt-5.6"]);
    expect(result["claude-code"]).toBeUndefined();
  });

  it("treats null as empty and rejects non-objects", () => {
    expect(normalizeHarnessModels(null)).toEqual({});
    expect(() => normalizeHarnessModels("nope")).toThrow();
    expect(() => normalizeHarnessModels([])).toThrow();
  });

  it("merges custom ids after the built-ins without reordering or duplicating", () => {
    const merged = resolveHarnessModelOptions("claude-code", {
      "claude-code": ["claude-opus-5", "claude-opus-4-6"],
    });
    expect(merged.slice(0, HARNESS_MODEL_OPTIONS["claude-code"].length)).toEqual(
      HARNESS_MODEL_OPTIONS["claude-code"],
    );
    expect(merged).toContain("claude-opus-5");
    expect(merged.filter((id) => id === "claude-opus-4-6")).toHaveLength(1);
  });

  it("returns only the built-ins when nothing custom is stored", () => {
    expect(resolveHarnessModelOptions("codex", undefined)).toEqual(HARNESS_MODEL_OPTIONS.codex);
    expect(resolveHarnessModelOptions("codex", {})).toEqual(HARNESS_MODEL_OPTIONS.codex);
    expect(resolveHarnessModelOptions("unknown-prefix", {})).toEqual([]);
  });
});

describe("resolveHarnessProfiles", () => {
  it("synthesizes a Claude Desktop profile from the legacy setting", () => {
    const result = resolveHarnessProfiles({ claudeMessagesRoute: "deepseek-flash" });
    expect(result["claude-desktop"]).toEqual({
      enabled: true,
      label: "Claude Desktop",
      mappings: [{ match: "claude-*", target: "deepseek-flash" }],
    });
  });

  it("prefers explicit profiles over the legacy setting", () => {
    const result = resolveHarnessProfiles({
      claudeMessagesRoute: "deepseek-flash",
      harnessProfiles: { codex: { enabled: true, mappings: [{ match: "gpt-*", target: "cx/gpt-5.6-sol" }] } },
    });
    expect(result["claude-desktop"]).toBeUndefined();
    expect(result.codex.mappings).toHaveLength(1);
  });

  it("returns empty when neither setting is present", () => {
    expect(resolveHarnessProfiles({})).toEqual({});
    expect(resolveHarnessProfiles(null)).toEqual({});
  });
});

describe("resolveHarnessTarget", () => {
  const settings = {
    harnessProfiles: {
      "claude-code": {
        enabled: true,
        mappings: [{ match: "claude-opus-*", target: "cx/gpt-5.6-sol" }],
      },
    },
  };

  it("resolves a mapped model on a harness URL", () => {
    const result = resolveHarnessTarget(URL_FOR("/claude-code/v1/messages"), "claude-opus-5", settings);
    expect(result).toMatchObject({ prefix: "claude-code", target: "cx/gpt-5.6-sol" });
  });

  it("does not take over a URL with no harness prefix", () => {
    expect(resolveHarnessTarget(URL_FOR("/v1/messages"), "claude-opus-5", settings)).toBeNull();
  });

  it("does not take over when the profile is disabled or the model is unmapped", () => {
    const disabled = { harnessProfiles: { "claude-code": { enabled: false, mappings: [{ match: "claude-*", target: "p/x" }] } } };
    expect(resolveHarnessTarget(URL_FOR("/claude-code/v1/messages"), "claude-opus-5", disabled)).toBeNull();
    expect(resolveHarnessTarget(URL_FOR("/claude-code/v1/messages"), "gemini-2", settings)).toBeNull();
  });
});
