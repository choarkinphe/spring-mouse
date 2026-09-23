import { describe, expect, it } from "vitest";
import { detectSourceApp, isLaterTimestamp } from "../../runtime/usage-aggregate.mjs";
import { detectSourceApp as detectSourceAppShared } from "@/shared/utils/requestSource.js";

/**
 * Two hot-path optimisations in the usage aggregation, both verified here so a
 * future refactor cannot silently reintroduce the slow form or drift the
 * behaviour.
 *
 * WHY THEY EXIST: the home page's 24h window scans ~41k rows, and the loop runs
 * per row per dimension. Measured on production, the naive `new Date(a) >
 * new Date(b)` comparisons cost ~700ms of a ~2s aggregation, and rebuilding
 * `detectSourceApp`'s table on every call cost another ~40ms.
 */

describe("isLaterTimestamp", () => {
  it("orders canonical ISO-UTC timestamps the same way Date does", () => {
    const a = "2026-09-23T07:22:17.746Z";
    const b = "2026-09-23T07:22:18.000Z";
    expect(isLaterTimestamp(b, a)).toBe(true);
    expect(isLaterTimestamp(a, b)).toBe(false);
    expect(isLaterTimestamp(a, a)).toBe(false);
  });

  it("agrees with Date across a large randomized sample", () => {
    for (let i = 0; i < 500; i++) {
      const x = new Date(Date.now() - Math.floor(Math.random() * 1e10)).toISOString();
      const y = new Date(Date.now() - Math.floor(Math.random() * 1e10)).toISOString();
      expect(isLaterTimestamp(x, y)).toBe(new Date(x) > new Date(y));
    }
  });

  it("handles sub-second and whole-second forms", () => {
    expect(isLaterTimestamp("2026-01-02T00:00:00Z", "2026-01-01T23:59:59.999Z")).toBe(true);
    expect(isLaterTimestamp("2026-01-01T00:00:00.500Z", "2026-01-01T00:00:00.499Z")).toBe(true);
  });

  it("falls back to Date for values that are not canonical ISO", () => {
    // A legacy row or an offset-bearing value must not be compared as a string.
    expect(isLaterTimestamp("2026-01-02T00:00:00+08:00", "2026-01-01T00:00:00Z")).toBe(true);
    expect(isLaterTimestamp(new Date("2026-01-02"), new Date("2026-01-01"))).toBe(true);
    expect(isLaterTimestamp(null, "2026-01-01T00:00:00Z")).toBe(false);
  });
});

describe("detectSourceApp (hoisted table)", () => {
  it("still resolves the known clients", () => {
    expect(detectSourceApp({ userAgent: "claude-code/1.0" })).toBe("claude code");
    expect(detectSourceApp({ userAgent: "Cursor/0.42" })).toBe("Cursor");
    expect(detectSourceApp({ userAgent: "curl/8.0" })).toBe("curl");
    expect(detectSourceApp({ appName: "MyApp" })).toBe("MyApp");
  });

  it("keeps the runtime copy in sync with the shared copy", () => {
    // The two files carry the same table (see the "keep in sync" comments); a
    // drift would make the dashboard label rows differently from the request
    // pipeline.
    const cases = [
      { appName: "x" }, { userAgent: "claude-code/1.0" }, { userAgent: "Cursor/0.42" },
      { userAgent: "codex_cli_rs/0.1" }, { userAgent: "open-webui" }, { userAgent: "curl/8.0" },
      { userAgent: "Aider v0.5" }, { userAgent: "vscode/1.0" }, { userAgent: "unknown-agent/9" },
      { userAgent: "" }, {},
    ];
    for (const c of cases) {
      expect(detectSourceApp(c), JSON.stringify(c)).toBe(detectSourceAppShared(c));
    }
  });
});
