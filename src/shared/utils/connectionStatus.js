export function getStatusVariant(isActive, effectiveStatus) {
  if (isActive === false) return "default";
  if (effectiveStatus === "active" || effectiveStatus === "success") return "success";
  if (effectiveStatus === "limited" || effectiveStatus === "degraded") return "warning";
  if (effectiveStatus === "error" || effectiveStatus === "expired" || effectiveStatus === "unavailable") return "error";
  return "default";
}

const MODEL_LOCK_PREFIX = "modelLock_";

/** Is any model cooldown on this connection still running? */
export function hasActiveModelLock(connection, now = Date.now()) {
  if (!connection) return false;
  for (const [key, value] of Object.entries(connection)) {
    if (!key.startsWith(MODEL_LOCK_PREFIX) || !value) continue;
    const at = new Date(value).getTime();
    if (Number.isFinite(at) && at > now) return true;
  }
  return false;
}

/**
 * Statuses that a *cooldown* produced: rate limit, upstream 5xx, unavailable.
 * They describe a moment, not the account, so they stop counting once the
 * cooldown that wrote them has run out.
 *
 * Without this a single host-wide network outage — every account in the pool
 * fails inside one rotation pass — leaves every channel reading 过载 for good,
 * because nothing except a *later successful request on that very account*
 * ever clears testStatus. That is what made a two-minute incident look like
 * every channel being permanently overloaded.
 */
const COOLDOWN_STATUSES = new Set(["limited", "degraded", "unavailable"]);

/**
 * `testStatus` with its cooldown applied. Rows written before `testStatusUntil`
 * existed fall back to the model locks, which are the only expiry evidence
 * those rows carry.
 */
export function getEffectiveConnectionStatus(connection, now = Date.now()) {
  const status = connection?.testStatus;
  if (!status) return "active";
  if (!COOLDOWN_STATUSES.has(status)) return status;
  if (connection.testStatusUntil) {
    const until = new Date(connection.testStatusUntil).getTime();
    return Number.isFinite(until) && until > now ? status : "active";
  }
  return hasActiveModelLock(connection, now) ? status : "active";
}

/**
 * The account badge rendered in the channel list and the account rows. It lives
 * here instead of inside the component so the rule can be asserted without a
 * browser, and so every surface derives the badge from the same place.
 * variant: muted | warning | error | success
 */
export function getAccountStatusInfo(connection, now = Date.now()) {
  if (connection?.isActive === false) return { label: "已停用", variant: "muted" };
  const status = getEffectiveConnectionStatus(connection, now);

  if (status === "limited") return { label: "限流", variant: "warning" };
  if (status === "degraded") return { label: "过载", variant: "warning" };
  if (status === "error" || status === "expired") return { label: "异常", variant: "error" };
  if (status === "unavailable") {
    const code = Number(connection.errorCode ?? connection.lastUpstreamStatus);
    if (code === 429) return { label: "限流", variant: "warning" };
    if (code >= 500) return { label: "过载", variant: "warning" };
    return { label: "异常", variant: "error" };
  }
  if (status === "active" || status === "success") return { label: "可用", variant: "success" };
  return { label: "待检测", variant: "warning" };
}
