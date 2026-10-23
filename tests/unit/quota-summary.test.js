import { describe, expect, it } from "vitest";
import { summarizeQuotaRows } from "../../src/app/(dashboard)/dashboard/providers/components/quotaSummary.js";

const pack = (n, total, used, resetAt) => ({ name: `Bonus Pack ${n}`, total, used, recurring: false, unit: "积分", resetAt });

describe("quota rows for accounts with many credit packs", () => {
  it("keeps the recurring allowance and folds the bonus packs into one row", () => {
    const rows = summarizeQuotaRows([
      { name: "Monthly", total: 500, used: 500, recurring: true, unit: "积分", resetAt: "2026-10-31T00:00:00Z" },
      pack(1, 100, 100, "2026-10-24T13:00:00Z"),
      pack(2, 100, 0, "2026-10-24T13:00:00Z"),
      pack(3, 100, 100, "2026-11-15T00:00:00Z"),
      pack(4, 100, 0, "2026-11-20T00:00:00Z"),
      pack(5, 100, 0, "2026-11-25T00:00:00Z"),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].quota.name).toBe("Monthly");
    expect(rows[1].quota).toMatchObject({ name: "赠送包 5 项", total: 500, used: 200, unit: "积分" });
    // Earliest expiry is the one the operator must act on.
    expect(rows[1].quota.resetAt).toBe("2026-10-24T13:00:00Z");
    expect(rows[1].detail).toHaveLength(5);
  });

  it("leaves a single bonus pack alone", () => {
    const rows = summarizeQuotaRows([{ name: "Monthly", total: 1, used: 0, recurring: true }, pack(1, 10, 1)]);
    expect(rows.map((r) => r.quota.name)).toEqual(["Monthly", "Bonus Pack 1"]);
    expect(rows[1].detail).toBeUndefined();
  });

  it("does not touch providers whose quotas are not one-shot packs", () => {
    const quotas = [
      { name: "5-hour", used: 1, total: 10 },
      { name: "Weekly", used: 2, total: 10 },
      { name: "Monthly", used: 3, total: 10 },
    ];
    expect(summarizeQuotaRows(quotas).map((r) => r.quota)).toEqual(quotas);
  });

  it("never drops packs whose totals are unknown", () => {
    const rows = summarizeQuotaRows([pack(1, 100, 0), { name: "Bonus Pack 2", recurring: false }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toHaveLength(2);
  });
});
