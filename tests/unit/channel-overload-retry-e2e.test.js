import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = await mkdtemp(path.join(tmpdir(), "sm-e2e-retry-"));
let PATCH, getSettings, resolveOverloadRetryConfig, resolveOverloadDelayMs;

beforeAll(async () => {
  ({ PATCH } = await import("@/app/api/settings/route.js"));
  ({ getSettings } = await import("@/lib/localDb"));
  ({ resolveOverloadRetryConfig, resolveOverloadDelayMs } = await import("open-sse/config/runtimeConfig.js"));
});

describe("E2E: channel modal -> settings API -> executor", () => {
  it("carries the retry curve from the form to the executor config", async () => {
    const res = await PATCH(new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerStrategies: {
          codex: {
            fallbackStrategy: "round-robin",
            overloadThreshold: 20,
            overloadRetryBudgetSeconds: 120,
            overloadRetryBaseDelaySeconds: 4,
            overloadRetryMaxDelaySeconds: 20,
          },
        },
      }),
    }));
    expect(res.status).toBe(200);

    const settings = await getSettings();
    const stored = settings.providerStrategies?.codex;
    console.log("persisted:", JSON.stringify(stored));

    expect(stored.overloadRetryBudgetMs).toBe(120_000);
    expect(stored.overloadRetryBaseDelayMs).toBe(4_000);
    expect(stored.overloadRetryMaxDelayMs).toBe(20_000);
    expect(stored.overloadThreshold).toBe(20);

    const cfg = resolveOverloadRetryConfig(stored);
    console.log("executor cfg:", cfg.budgetMs, cfg.baseDelayMs, cfg.maxDelayMs);
    console.log("curve:", [1,2,3,4,5].map(n => resolveOverloadDelayMs(n, cfg)).join(" -> "));

    expect(cfg.budgetMs).toBe(120_000);
    expect(cfg.baseDelayMs).toBe(4_000);
    expect(cfg.maxDelayMs).toBe(20_000);

    const plain = resolveOverloadRetryConfig({ fallbackStrategy: "round-robin" });
    expect(plain.budgetMs).toBe(90_000);
    expect(plain.baseDelayMs).toBe(3_000);
    expect(plain.maxDelayMs).toBe(15_000);
  });

  it("carries the byte-silence watchdog from the form to the strategy entry", async () => {
    // The watchdog is read at stream time from credentials.providerStrategy, so
    // what matters is that the value the operator typed survives the round trip
    // in the unit the runtime expects (ms).
    const res = await PATCH(new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerStrategies: { codex: { stallTimeoutSeconds: 120 } },
      }),
    }));
    expect(res.status).toBe(200);

    const settings = await getSettings();
    const stored = settings.providerStrategies?.codex;
    expect(stored.stallTimeoutMs).toBe(120_000);

    // And the registry default it overrides is the 170s bound chosen from the
    // production TTFT distribution (below the client's 180s, above the slowest
    // legitimate turn at 165.7s).
    const { PROVIDERS } = await import("open-sse/providers/index.js");
    expect(PROVIDERS.codex.stallTimeoutMs).toBe(170_000);
  });
});
