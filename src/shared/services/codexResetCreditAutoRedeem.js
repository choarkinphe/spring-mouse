// Auto-redeem Codex rate-limit reset credits shortly before they expire.
// An unused credit is simply lost at expiry, so spending it a little early is
// never worse than letting it lapse. Fail-open: no error escapes a tick.

const DEFAULT_LEAD_MINUTES = 120;
const INTERVAL_MS = 15 * 60 * 1000;
const INITIAL_DELAY_MS = 45 * 1000;
const LOCK_TTL_SECONDS = 10 * 60;
const INACTIVE_STATUSES = new Set(["redeemed", "consumed", "used", "expired", "cancelled", "revoked"]);

const state = globalThis.__codexResetCreditAutoRedeem ??= {
  timer: null,
  initialTimer: null,
  running: false,
  // connectionId -> expiresAt we already redeemed for, guards against an
  // upstream that is slow to flip the consumed credit's status.
  redeemedFor: new Map(),
};

function isTruthyEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

export function getAutoRedeemLeadMs() {
  const minutes = Number.parseFloat(process.env.CODEX_RESET_CREDIT_AUTO_REDEEM_LEAD_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_LEAD_MINUTES) * 60 * 1000;
}

/**
 * The earliest-expiring usable credit that expires within `leadMs`, or null.
 * @param {Array<{status?: string, expiresAt?: string|null}>} credits
 */
export function findCreditDueForRedeem(credits, nowMs = Date.now(), leadMs = getAutoRedeemLeadMs()) {
  if (!Array.isArray(credits)) return null;
  let due = null;
  for (const credit of credits) {
    if (INACTIVE_STATUSES.has(String(credit?.status || "").trim().toLowerCase())) continue;
    const expiresAtMs = credit?.expiresAt ? new Date(credit.expiresAt).getTime() : NaN;
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) continue;
    if (expiresAtMs - nowMs > leadMs) continue;
    if (!due || expiresAtMs < new Date(due.expiresAt).getTime()) due = credit;
  }
  return due;
}

function isCodexCreditConnection(connection) {
  if (!connection || connection.provider !== "codex" || connection.isActive === false) return false;
  return connection.authType === "oauth" || connection.authType === "access_token";
}

async function acquireLock(connectionId) {
  // Several replicas may share one DB; only one should spend the credit.
  // Without Redis this is a single process, and state.running already serializes.
  if (!process.env.SPRING_MOUSE_REDIS_URL) return true;
  try {
    const { routingRedis } = await import("@/lib/redis/routingClient.js");
    const result = await routingRedis((client) => client.set(
      `spring-mouse:codex-reset-credit-redeem:${connectionId}`,
      String(Date.now()),
      { EX: LOCK_TTL_SECONDS, condition: "NX" },
    ));
    return result === "OK";
  } catch {
    return false;
  }
}

async function defaultResolveContext(connection) {
  const { resolveConnectionProxyConfig } = await import("@/lib/network/connectionProxy");
  const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData);
  const proxyOptions = {
    connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
    connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
    connectionNoProxy: proxyConfig.connectionNoProxy || "",
    strictProxy: false,
  };
  let current = connection;
  if (connection.authType === "oauth") {
    // Non-forced: only refreshes when the token is actually near expiry, so this
    // does not race the request path's rotating Codex refresh tokens.
    const { checkAndRefreshToken } = await import("@/sse/services/tokenRefresh.js");
    current = { ...connection, ...(await checkAndRefreshToken("codex", connection)) };
  }
  return { connection: current, proxyOptions };
}

async function defaultLoadConnections() {
  const { getProviderConnections } = await import("@/lib/db/repos/connectionsRepo.js");
  return getProviderConnections({ isActive: true, provider: "codex" });
}

async function defaultServices() {
  const { getCodexRateLimitResetCredits, consumeCodexRateLimitResetCredit } = await import("open-sse/services/usage.js");
  return { getCredits: getCodexRateLimitResetCredits, consumeCredit: consumeCodexRateLimitResetCredit };
}

export async function runCodexResetCreditAutoRedeemTick(deps = {}) {
  if (state.running) return { skipped: "running" };
  state.running = true;
  const summary = { checked: 0, redeemed: 0, failed: 0 };
  try {
    const loadConnections = deps.loadConnections || defaultLoadConnections;
    const resolveContext = deps.resolveContext || defaultResolveContext;
    const lock = deps.acquireLock || acquireLock;
    const { getCredits, consumeCredit } = deps.getCredits && deps.consumeCredit
      ? deps
      : await defaultServices();
    const now = deps.now || Date.now;
    const leadMs = deps.leadMs ?? getAutoRedeemLeadMs();

    const connections = (await loadConnections()).filter(isCodexCreditConnection);
    for (const raw of connections) {
      summary.checked++;
      try {
        const { connection, proxyOptions } = await resolveContext(raw);
        if (!connection?.accessToken) continue;
        const result = await getCredits(connection.accessToken, proxyOptions, connection.providerSpecificData);
        const due = findCreditDueForRedeem(result?.credits, now(), leadMs);
        if (!due) continue;
        if (state.redeemedFor.get(raw.id) === due.expiresAt) continue;
        if (!(await lock(raw.id))) continue;

        const redeemRequestId = crypto.randomUUID();
        const consumed = await consumeCredit(connection.accessToken, redeemRequestId, proxyOptions);
        if (consumed?.ok) {
          state.redeemedFor.set(raw.id, due.expiresAt);
          summary.redeemed++;
          console.log(`[CodexResetCredit] auto-redeemed expiring credit for ${raw.name || raw.id} (expires ${due.expiresAt})`);
        } else {
          summary.failed++;
          console.warn(`[CodexResetCredit] auto-redeem for ${raw.name || raw.id} returned ${consumed?.code || consumed?.status || "unknown"}`);
        }
      } catch (error) {
        summary.failed++;
        console.warn(`[CodexResetCredit] auto-redeem check failed for ${raw?.name || raw?.id}: ${error?.message || error}`);
      }
    }
    return summary;
  } catch (error) {
    console.warn(`[CodexResetCredit] tick failed: ${error?.message || error}`);
    return { ...summary, error: "tick_failed" };
  } finally {
    state.running = false;
  }
}

export function startCodexResetCreditAutoRedeem() {
  if (state.timer || typeof window !== "undefined" || process.env.NEXT_RUNTIME === "edge"
    || ["phase-production-build", "phase-export", "phase-static"].includes(process.env.NEXT_PHASE)) return false;
  if (isTruthyEnv(process.env.DISABLE_CODEX_RESET_CREDIT_AUTO_REDEEM)) {
    console.log("[CodexResetCredit] auto-redeem disabled via DISABLE_CODEX_RESET_CREDIT_AUTO_REDEEM");
    return false;
  }
  const tick = () => { void runCodexResetCreditAutoRedeemTick(); };
  state.initialTimer = setTimeout(() => { state.initialTimer = null; tick(); }, INITIAL_DELAY_MS);
  state.initialTimer.unref?.();
  state.timer = setInterval(tick, INTERVAL_MS);
  state.timer.unref?.();
  return true;
}

export function stopCodexResetCreditAutoRedeem() {
  clearTimeout(state.initialTimer);
  clearInterval(state.timer);
  state.initialTimer = null;
  state.timer = null;
}
