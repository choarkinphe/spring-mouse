// Credit subscriptions are not priced at the underlying vendor's $/token rate.
// Include legacy aliases because saved traffic/model rows may still use them.
const CREDIT_PROVIDERS = new Set([
  "qoder", "qd", "qoder-cn", "qdcn",
  "workbuddy", "wb", "cbcn", "workbuddy-ai", "wbai", "cbai",
  "codebuddy-cn", "cbc", "codebuddy-intl", "cbi",
  "kiro", "kr",
]);

export function usesCreditBilling(provider) {
  return CREDIT_PROVIDERS.has(provider);
}

export function creditNumber(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

// Kept separate from monetary pricing: a multiplier cannot calculate dollars
// or exact points from token counts without the provider's billing formula.
export function modelCreditBilling(provider, model = {}) {
  if (!usesCreditBilling(provider)) return null;
  const multiplier = creditNumber(model.rateMultiplier);
  const originalMultiplier = creditNumber(model.originalRateMultiplier);
  return { unit: "credits", multiplier,
    ...(originalMultiplier !== null && multiplier !== null && originalMultiplier > multiplier
      ? { originalMultiplier } : {}),
  };
}
