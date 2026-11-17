import { describe, expect, it } from "vitest";

// The dashboard utils import open-sse via vitest aliases, so run through vitest.
const { formatQuotaAmount, formatQuotaRemainingLabel } = await import(
  "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js"
);

describe("ProviderLimits dollar appendix (smoke)", () => {
  it("appends dollar ceilings to percentage rows with usedUsd/totalUsd", () => {
    expect(formatQuotaAmount({ used: 25, total: 100, unit: "%", usedUsd: 5, totalUsd: 20, currency: "USD" }))
      .toMatch(/25% \/ 100% \(.*\$5\.00.* \/ .*\$20\.00.*\)/);
    // Percent rows without dollar fields are unchanged.
    expect(formatQuotaAmount({ used: 25, total: 100, unit: "%" })).toBe("25% / 100%");
  });

  it("keeps percentage as the remaining figure for % quotas with dollar ceilings", () => {
    expect(formatQuotaRemainingLabel({ used: 25, total: 100, unit: "%", usedUsd: 5, totalUsd: 20, currency: "USD" }))
      .toBe("余量 75%");
    expect(formatQuotaRemainingLabel({ used: 100, total: 100, unit: "%", usedUsd: 20, totalUsd: 20 }))
      .toBe("余量 0%");
  });

  it("keeps counted quotas with currency on the old behavior", () => {
    // A non-% unit with currency must still render its currency remaining.
    expect(formatQuotaRemainingLabel({ used: 4, total: 10, unit: "USD", currency: "USD" }))
      .toBe("余量 $6.00");
  });
});
