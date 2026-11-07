import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  findCreditDueForRedeem,
  runCodexResetCreditAutoRedeemTick,
} from "../../src/shared/services/codexResetCreditAutoRedeem.js";

const NOW = Date.parse("2026-11-07T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

describe("findCreditDueForRedeem", () => {
  it("picks the earliest usable credit inside the lead window", () => {
    const credits = [
      { status: "available", expiresAt: iso(NOW + 90 * 60 * 1000) },
      { status: "available", expiresAt: iso(NOW + 30 * 60 * 1000) },
      { status: "available", expiresAt: iso(NOW + 48 * HOUR) },
    ];
    expect(findCreditDueForRedeem(credits, NOW, 2 * HOUR)?.expiresAt).toBe(iso(NOW + 30 * 60 * 1000));
  });

  it("ignores consumed, expired, far-off and undated credits", () => {
    const credits = [
      { status: "redeemed", expiresAt: iso(NOW + HOUR) },
      { status: "available", expiresAt: iso(NOW - HOUR) },
      { status: "available", expiresAt: iso(NOW + 3 * HOUR) },
      { status: "available", expiresAt: null },
    ];
    expect(findCreditDueForRedeem(credits, NOW, 2 * HOUR)).toBeNull();
  });
});

describe("runCodexResetCreditAutoRedeemTick", () => {
  let deps;
  beforeEach(() => {
    globalThis.__codexResetCreditAutoRedeem.redeemedFor.clear();
    deps = {
      now: () => NOW,
      leadMs: 2 * HOUR,
      loadConnections: vi.fn(async () => [
        { id: "a", provider: "codex", authType: "oauth", isActive: true },
        { id: "b", provider: "codex", authType: "apikey", isActive: true },
      ]),
      resolveContext: vi.fn(async (connection) => ({ connection: { ...connection, accessToken: "tok" }, proxyOptions: null })),
      acquireLock: vi.fn(async () => true),
      getCredits: vi.fn(async () => ({ credits: [{ status: "available", expiresAt: iso(NOW + HOUR) }] })),
      consumeCredit: vi.fn(async () => ({ ok: true, code: "reset" })),
    };
  });

  it("redeems an expiring credit once and skips non-credit connections", async () => {
    const first = await runCodexResetCreditAutoRedeemTick(deps);
    expect(first).toMatchObject({ checked: 1, redeemed: 1, failed: 0 });
    expect(deps.consumeCredit).toHaveBeenCalledTimes(1);

    // Upstream still lists the same credit as available: do not spend another.
    const second = await runCodexResetCreditAutoRedeemTick(deps);
    expect(second.redeemed).toBe(0);
    expect(deps.consumeCredit).toHaveBeenCalledTimes(1);
  });

  it("does nothing when no credit is near expiry", async () => {
    deps.getCredits.mockResolvedValue({ credits: [{ status: "available", expiresAt: iso(NOW + 10 * HOUR) }] });
    await runCodexResetCreditAutoRedeemTick(deps);
    expect(deps.consumeCredit).not.toHaveBeenCalled();
  });

  it("skips when another instance holds the lock", async () => {
    deps.acquireLock.mockResolvedValue(false);
    await runCodexResetCreditAutoRedeemTick(deps);
    expect(deps.consumeCredit).not.toHaveBeenCalled();
  });

  it("swallows per-connection failures", async () => {
    deps.getCredits.mockRejectedValue(new Error("boom"));
    const result = await runCodexResetCreditAutoRedeemTick(deps);
    expect(result).toMatchObject({ checked: 1, failed: 1 });
  });
});
