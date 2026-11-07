import { createHash, randomUUID } from "node:crypto";
import { ROLE } from "../translator/schema/index.js";

/**
 * Trusted site definitions shared by chat, OAuth, discovery and refresh.
 * `productId` binds saved credentials to a provider; `headerProduct` is the
 * upstream API's SaaS product, not an assertion that Spring Mouse is an IDE.
 * Origins are never taken from credentials or caller headers.
 */
export const WORKBUDDY_SITES = Object.freeze({
  workbuddy: Object.freeze({
    id: "workbuddy", productId: "workbuddy", platform: "workbuddy",
    origin: "https://copilot.tencent.com", domain: "copilot.tencent.com",
    chatUrl: "https://copilot.tencent.com/v2/chat/completions",
    stateUrl: "https://copilot.tencent.com/v2/plugin/auth/state",
    // Billing/quota path shared with CodeBuddy CN (see services/usage/codebuddy-cn.js).
    usageUrl: "https://copilot.tencent.com/v2/billing/meter/get-user-resource",
    tokenUrl: "https://copilot.tencent.com/v2/plugin/auth/token",
    refreshUrl: "https://copilot.tencent.com/v2/plugin/auth/token/refresh",
    headerProduct: "SaaS", format: "openai",
  }),
  "workbuddy-ai": Object.freeze({
    id: "workbuddy-ai", productId: "workbuddy-ai", platform: "workbuddy-ai",
    origin: "https://www.workbuddy.ai", domain: "www.workbuddy.ai",
    chatUrl: "https://www.workbuddy.ai/v2/chat/completions",
    stateUrl: "https://www.workbuddy.ai/v2/plugin/auth/state",
    usageUrl: "https://www.workbuddy.ai/v2/billing/meter/get-user-resource",
    tokenUrl: "https://www.workbuddy.ai/v2/plugin/auth/token",
    refreshUrl: "https://www.workbuddy.ai/v2/plugin/auth/token/refresh",
    headerProduct: "SaaS", format: "openai",
  }),
});

// Identify this gateway truthfully. These values are not an official-client
// attestation and do not establish entitlement to a private upstream endpoint.
export const WORKBUDDY_CLIENT = Object.freeze({
  userAgent: "Spring-Mouse/WorkBuddy-Gateway",
});

export const WORKBUDDY_LEGACY = Object.freeze({
  status: 409,
  message: "Legacy CodeBuddy credentials cannot use the WorkBuddy channel. Authorize the correct product explicitly; restricted accounts must remain disabled until the provider lifts the restriction.",
});

export function requiresWorkBuddyAuthorization(provider, credentials) {
  return (provider === "workbuddy" || provider === "workbuddy-ai")
    && credentials?.providerSpecificData?.workbuddyLegacyCredential === true;
}

export function assertWorkBuddyCredential(credentials) {
  if (credentials?.providerSpecificData?.workbuddyLegacyCredential === true) {
    throw new Error(WORKBUDDY_LEGACY.message);
  }
}

export const WORKBUDDY_REQUEST = Object.freeze({
  neutralSystem: "You are a helpful assistant.",
  disabledReasoning: Object.freeze(["none", "off"]),
  reasoningSummary: "auto",
});

export function getWorkBuddySite(provider) {
  if (!Object.hasOwn(WORKBUDDY_SITES, provider)) throw new Error(`Unsupported WorkBuddy provider: ${provider}`);
  return WORKBUDDY_SITES[provider];
}

// Retain legacy origin evidence for read-only account inspection. It does not
// authorize chat, refresh or discovery through the new product; those paths
// reject legacy credentials. Never send an old token to the new product host.
export const LEGACY_ORIGINS = Object.freeze({
  workbuddy: "https://copilot.tencent.com",
  "workbuddy-ai": "https://www.codebuddy.ai",
});

/**
 * Effective site for a saved connection: the trusted site, unless the credential
 * is a legacy CodeBuddy one whose evidence pins it to its original origin.
 */
export function resolveWorkBuddySite(provider, metadata = {}) {
  const site = getWorkBuddySite(provider);
  if (metadata.workbuddyLegacyCredential !== true) return site;
  const origin = metadata.workbuddyEndpointOrigin;
  if (origin !== LEGACY_ORIGINS[provider]) throw new Error("WorkBuddy legacy credential origin mismatch");
  if (origin === site.origin) return site;
  const domain = new URL(origin).hostname;
  return Object.freeze({
    ...site, origin, domain,
    chatUrl: `${origin}/v2${new URL(site.chatUrl).pathname.split("/v2")[1]}`,
    headerProduct: "SaaS",
  });
}

function headerValue(value, name) {
  if (typeof value !== "string" || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`Invalid WorkBuddy ${name}`);
  }
  return value.trim();
}

// Process-salted correlation digests never transmit the raw session or message.
const ID_SALT = randomUUID();
function conversationId(key) {
  return createHash("sha256").update(`${ID_SALT}|${key}`).digest("hex").slice(0, 32);
}

function contentKey(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || !content.length) return "";
  // Include non-text input as well: two image/file sends need distinct keys.
  return JSON.stringify(content);
}

// conversationKey names the conversation a chat belongs to: the session the
// caller names, else its first user message, which every later turn repeats.
function conversationKey(conversation) {
  if (conversation?.sessionId) return `session:${conversation.sessionId}`;
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  for (const message of messages) {
    if (message?.role !== ROLE.USER) continue;
    const text = contentKey(message.content);
    if (text) return `first:${text}`;
  }
  return "";
}

// turnKey names the user send a chat answers: its last user message that is the
// user's own, so every step of one send repeats it and the next send changes it.
function turnKey(conversation) {
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== ROLE.USER) continue;
    const previous = messages[i - 1];
    if (previous?.role === ROLE.TOOL) continue;
    if (previous?.role === ROLE.ASSISTANT && Array.isArray(previous.tool_calls) && previous.tool_calls.length) continue;
    const text = contentKey(message.content);
    if (text) return `u${i}:${text}`;
  }
  return "";
}

/**
 * Build a new allowlisted header object, never merging rawHeaders, cookies,
 * runtime transport headers, API keys or any other client's identity.
 *
 * Saved credential contract (providerSpecificData):
 * - workbuddyProduct: provider id; workbuddyOrigin: exact trusted HTTPS origin;
 *   workbuddyPlatform: site platform; workbuddyContract: "0.1.30"; codebuddyUid.
 *   All required with an accessToken. OAuth setup may call without credentials.
 * - domain: matching host returned by the trusted endpoint (required for auth).
 * - codebuddyUid: optional user id from that endpoint's account response.
 * - enterpriseId / tenantId: accepted only with tenantVerified:true, written
 *   by OAuth after verifying this user's membership on the bound origin.
 *   The gateway uses the same enterprise id in both headers.
 * No boolean supplied in raw request headers establishes verification.
 */
export function buildWorkBuddyHeaders(provider, credentials = {}, { stream = false, conversation = null } = {}) {
  const metadata = credentials.providerSpecificData || {};
  const site = resolveWorkBuddySite(provider, metadata);
  assertWorkBuddyCredential(credentials);
  const bindings = {
    workbuddyProduct: WORKBUDDY_SITES[provider].productId, workbuddyOrigin: WORKBUDDY_SITES[provider].origin,
    workbuddyPlatform: WORKBUDDY_SITES[provider].platform, workbuddyContract: "0.1.30", domain: WORKBUDDY_SITES[provider].domain,
  };
  for (const [key, expected] of Object.entries(bindings)) {
    if (metadata[key] !== undefined && metadata[key] !== expected) {
      throw new Error(`WorkBuddy credential ${key} mismatch`);
    }
  }
  const bound = Object.entries(bindings).every(([key, expected]) => metadata[key] === expected);
  if (credentials.accessToken && (!bound || !metadata.codebuddyUid)) {
    throw new Error("WorkBuddy credentials require product, origin, platform, contract and UID binding");
  }
  if (metadata.tokenType !== undefined && metadata.tokenType !== "Bearer") throw new Error("Invalid WorkBuddy tokenType");
  const headers = {
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
    "User-Agent": WORKBUDDY_CLIENT.userAgent,
    "X-Product": site.headerProduct,
    "X-Domain": site.domain,
  };
  if (credentials.accessToken) headers.Authorization = `Bearer ${headerValue(credentials.accessToken, "accessToken")}`;
  if (metadata.codebuddyUid !== undefined) headers["X-User-Id"] = headerValue(metadata.codebuddyUid, "codebuddyUid");
  if (metadata.enterpriseId || metadata.tenantId) {
    if (metadata.tenantVerified !== true || !bound || !metadata.codebuddyUid) {
      throw new Error("WorkBuddy tenant metadata must be verified and bound to this account");
    }
    const enterprise = headerValue(metadata.enterpriseId, "enterpriseId");
    const tenant = metadata.tenantId === undefined ? enterprise : headerValue(metadata.tenantId, "tenantId");
    if (enterprise !== tenant) throw new Error("WorkBuddy tenant/enterprise mismatch");
    headers["X-Enterprise-Id"] = enterprise;
    headers["X-Tenant-Id"] = tenant;
  }
  if (stream) {
    // Correlate requests without claiming to be the official app. Account and
    // conversation scope prevent unrelated accounts/turns from sharing IDs.
    const scope = `${provider}|${metadata.codebuddyUid || ""}|${metadata.enterpriseId || ""}`;
    const conversationKeyValue = conversationKey(conversation);
    const id = randomUUID();
    headers["X-Request-ID"] = id;
    headers["X-Conversation-Message-ID"] = id;
    if (conversationKeyValue) headers["X-Conversation-ID"] = conversationId(`${scope}|${conversationKeyValue}`);
    const turn = turnKey(conversation);
    headers["X-Conversation-Request-ID"] = turn && conversationKeyValue
      ? conversationId(`${scope}|${conversationKeyValue}|${turn}`) : id;
  }
  return headers;
}
