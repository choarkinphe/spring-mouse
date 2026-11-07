import { usesCreditBilling } from "open-sse/config/creditBilling.js";

export const BILLING_MODES = Object.freeze(["subscription", "metered", "hybrid", "free", "unknown"]);
export const BILLING_MODE_LABELS = Object.freeze({
  subscription: "订阅", metered: "按量计费", hybrid: "订阅 + 按量", free: "免费", unknown: "未知",
});

const SUBSCRIPTION_PROVIDERS = new Set([
  "codex", "cx", "cursor", "cu", "github", "gh", "copilot",
  "windsurf", "ws", "augment", "au", "antigravity", "ag", "trae", "tr",
  "glm", "glm-cn", "alicode", "alicode-intl", "minimax", "minimax-cn",
  "qianwen-token-plan", "xiaomi-tokenplan", "opencode-go", "kimi-coding", "kmc",
]);
const METERED_PROVIDERS = new Set([
  "openai", "anthropic", "claude", "cc", "openrouter", "deepseek", "mistral", "xai", "groq",
  "together", "fireworks", "perplexity", "siliconflow", "cerebras",
]);

export function isBillingMode(mode) {
  return BILLING_MODES.includes(mode);
}

// An API key alone says nothing about the commercial plan (coding plans often
// issue keys too). Unknown/custom providers must remain explicitly unknown.
export function resolveAccountBillingMode(connection = {}) {
  if (isBillingMode(connection.billingMode)) return connection.billingMode;
  const provider = connection.provider || "";
  if (usesCreditBilling(provider) || SUBSCRIPTION_PROVIDERS.has(provider)) return "subscription";
  if (connection.authType === "oauth") return "subscription";
  if (METERED_PROVIDERS.has(provider)) return "metered";
  return "unknown";
}

export function billingModeWarning(mode) {
  if (mode === "hybrid") return "Token 金额仅为参考估算，不能区分订阅内用量与额外按量账单。";
  if (mode === "unknown") return "计费方式未知，Token 参考估算不计入按量合计，也不代表实际账单。";
  if (mode === "metered") return "Token 金额为模型价格参考估算，不是上游实际账单。";
  return null;
}

export function normalizeBillingDate(value, field = "date") {
  // Require an unambiguous ISO timestamp with a zone, not Date.parse's locale
  // dates or rollover of impossible calendar dates (e.g. February 30).
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error(`${field} must be an ISO timestamp with timezone`);
  }
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  const zone = value.match(/([+-])(\d{2}):(\d{2})$/);
  const time = Date.parse(value);
  if (month < 1 || month > 12 || day < 1 || day > days || hour > 23 || minute > 59 || second > 59 ||
      (zone && (Number(zone[2]) > 23 || Number(zone[3]) > 59)) || !Number.isFinite(time)) {
    throw new Error(`${field} is not a valid date`);
  }
  return new Date(time).toISOString();
}

export function normalizeBillingRange(start, end) {
  const range = { start: normalizeBillingDate(start, "start"), end: normalizeBillingDate(end, "end") };
  if (range.start >= range.end) throw new Error("start must be before end");
  return range;
}

let currencies;
function supportedCurrency(currency) {
  // Intl.NumberFormat accepts arbitrary 3-letter codes, so also check the
  // runtime's actual ISO currency catalogue rather than accepting e.g. XYZ.
  currencies ||= new Set(Intl.supportedValuesOf("currency"));
  return currencies.has(currency);
}

export function normalizeBillingEntry(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Entry must be an object");
  if (typeof input.amount !== "number" || !Number.isFinite(input.amount) || input.amount < 0) {
    throw new Error("amount must be a finite non-negative number");
  }
  if (typeof input.currency !== "string" || !/^[A-Z]{3}$/.test(input.currency) || !supportedCurrency(input.currency)) {
    throw new Error("currency must be a supported uppercase ISO currency code");
  }
  const paidAt = normalizeBillingDate(input.paidAt, "paidAt");
  const startAt = normalizeBillingDate(input.startAt, "startAt");
  const endAt = normalizeBillingDate(input.endAt, "endAt");
  if (startAt >= endAt) throw new Error("startAt must be before endAt");
  if (input.note !== undefined && (typeof input.note !== "string" || input.note.length > 2000)) {
    throw new Error("note must be a string of at most 2000 characters");
  }
  if (input.id !== undefined && (typeof input.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.id))) {
    throw new Error("id must be a UUID");
  }
  return {
    ...(input.id !== undefined ? { id: input.id.toLowerCase() } : {}),
    amount: input.amount, currency: input.currency, paidAt, startAt, endAt, note: input.note || "",
  };
}

export function summarizeBillingEntries(entries, start, end) {
  const range = normalizeBillingRange(start, end);
  const from = Date.parse(range.start);
  const to = Date.parse(range.end);
  const subscriptionPaid = {};
  const subscriptionAccrued = {};
  const relevantEntries = [];
  for (const entry of entries) {
    const paid = Date.parse(entry.paidAt);
    const begins = Date.parse(entry.startAt);
    const ends = Date.parse(entry.endAt);
    const inPaidRange = paid >= from && paid < to;
    const overlap = Math.max(0, Math.min(to, ends) - Math.max(from, begins));
    if (inPaidRange) subscriptionPaid[entry.currency] = (subscriptionPaid[entry.currency] || 0) + entry.amount;
    if (overlap > 0) {
      subscriptionAccrued[entry.currency] = (subscriptionAccrued[entry.currency] || 0) + entry.amount * (overlap / (ends - begins));
    }
    if (inPaidRange || overlap > 0) relevantEntries.push(entry);
  }
  return { subscriptionPaid, subscriptionAccrued, entries: relevantEntries };
}

function tokenNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function normalizeAccountTokens(tokens = {}, fallback = {}) {
  const inputTokens = tokenNumber(tokens.prompt_tokens || tokens.input_tokens || fallback.promptTokens || 0);
  const outputTokens = tokenNumber(tokens.completion_tokens || tokens.output_tokens || fallback.completionTokens || 0);
  const cachedTokens = tokenNumber(tokens.cached_tokens || tokens.cache_read_input_tokens || tokens.prompt_tokens_details?.cached_tokens || 0);
  const cacheCreationTokens = tokenNumber(tokens.cache_creation_input_tokens || 0);
  // Cached/creation tokens are subsets of prompt tokens, not additional tokens.
  return { inputTokens, outputTokens, cachedTokens, cacheCreationTokens, totalTokens: inputTokens + outputTokens };
}
