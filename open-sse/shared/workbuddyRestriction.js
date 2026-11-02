import { WORKBUDDY_RESTRICTION } from "../config/errorConfig.js";

// Match the provider's structured business code, never a number mentioned in
// user text. HTTP and SSE errors use the same envelope (including legacy rows).
export function isWorkBuddyRestriction(provider, payload) {
  if (!WORKBUDDY_RESTRICTION.providers.has(provider)) return false;
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch { return false; }
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const code = payload?.error?.data?.code ?? payload?.error?.code
    ?? payload?.code ?? payload?.data?.code;
  return code === WORKBUDDY_RESTRICTION.code || code === String(WORKBUDDY_RESTRICTION.code);
}

export function workBuddyRestrictionResponse(message) {
  return Response.json({ error: { type: "permission_error", code: WORKBUDDY_RESTRICTION.code, message } }, { status: 403 });
}

export function hasWorkBuddyRestriction(provider, credentials) {
  return WORKBUDDY_RESTRICTION.providers.has(provider)
    && credentials?.accountRestriction?.code === WORKBUDDY_RESTRICTION.code;
}
