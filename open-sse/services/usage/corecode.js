/**
 * CoreCode (corecode.live) usage — new-api style prepaid balance.
 *
 *   GET {base}/v1/dashboard/billing/subscription
 *   GET {base}/v1/dashboard/billing/usage?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
 *   Auth: Authorization: Bearer <sk-key>
 *
 * subscription payload (verified against live account):
 *   { has_payment_method, soft_limit_usd, hard_limit_usd,
 *     system_hard_limit_usd, access_until }   // limits in USD, access_until=0 → none
 * usage payload: { total_usage }              // USD spent in the window (NOT quota units)
 *
 * Base URLs come from the registry's transport.usage so a regional override
 * stays a config change, not a code change.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { U, parseResetTime, toFiniteNumber } from "./shared.js";

const USAGE = U("corecode");
const BALANCE_URL = USAGE.url || "https://corecode.live/v1/dashboard/billing/subscription";
const SPEND_URL = USAGE.spendUrl || "https://corecode.live/v1/dashboard/billing/usage";

function thirtyDaysAgoIso() {
  return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

async function fetchJson(url, apiKey, proxyOptions) {
  const response = await proxyAwareFetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  }, proxyOptions);
  if (response.status === 401 || response.status === 403) {
    return { unauthorized: true };
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return { error: `HTTP ${response.status}${text ? `: ${text.slice(0, 160)}` : ""}` };
  }
  const data = await response.json().catch(() => null);
  return { data };
}

/**
 * @param {string|null|undefined} apiKey
 * @param {object|null} proxyOptions
 */
export async function getCoreCodeUsage(apiKey = null, proxyOptions = null) {
  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    return { message: "CoreCode API key not available. Add a key to view usage." };
  }
  const key = apiKey.trim();

  try {
    const sub = await fetchJson(BALANCE_URL, key, proxyOptions);
    if (sub.unauthorized) {
      return { plan: "CoreCode", message: "CoreCode authentication failed. Check the API key." };
    }
    if (sub.error) {
      return { plan: "CoreCode", message: `CoreCode balance API error ${sub.error}` };
    }
    const d = sub.data;
    if (!d || typeof d !== "object") {
      return { message: "CoreCode balance response was not JSON." };
    }

    const quotas = {};
    const accessUntil = parseResetTime(d.access_until ?? d.accessUntil ?? d.expires_at ?? d.expiresAt);

    // Remaining balance is not in this payload: limits are a huge default and
    // `used_amount` is absent. Spend comes from the billing/usage window.
    const softUsd = toFiniteNumber(d.soft_limit_usd ?? d.softLimitUsd, 0);
    const hardUsd = toFiniteNumber(d.hard_limit_usd ?? d.hardLimitUsd, 0);
    const capUsd = Math.min(
      hardUsd > 0 ? hardUsd : Infinity,
      softUsd > 0 ? softUsd : Infinity,
    );
    if (Number.isFinite(capUsd) && capUsd < 1e8) {
      // Account has a real (non-default) spending cap.
      quotas["消费上限 (USD)"] = {
        used: 0,
        total: capUsd,
        currency: "USD",
        resetAt: accessUntil,
      };
    }

    // Last-30-days spend — the only money number this gateway reports.
    const spend = await fetchJson(
      `${SPEND_URL}?start_date=${thirtyDaysAgoIso()}&end_date=${todayIso()}`,
      key,
      proxyOptions,
    );
    const spendUsd = toFiniteNumber(spend.data?.total_usage ?? spend.data?.totalUsage ?? spend.data?.quota, NaN);
    if (Number.isFinite(spendUsd)) {
      quotas["近 30 天消费 (USD)"] = {
        used: spendUsd,
        total: 0,
        // Cumulative spend, not a quota: renders as an amount, never as
        // remaining percentage or "unlimited".
        spend: true,
        balance: spendUsd,
        currency: "USD",
        resetAt: null,
      };
    } else if (spend.error || spend.unauthorized) {
      return { plan: "CoreCode", message: `CoreCode spend API error ${spend.error || "(unauthorized)"}` };
    }

    if (Object.keys(quotas).length === 0) {
      return {
        plan: "CoreCode",
        message: "CoreCode connected. No usage data returned.",
      };
    }

    return {
      plan: accessUntil ? `CoreCode (访问至 ${accessUntil.slice(0, 10)})` : "CoreCode",
      quotas,
    };
  } catch (error) {
    return { message: `CoreCode error: ${error.message}` };
  }
}
