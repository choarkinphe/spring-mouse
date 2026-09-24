import { BaseExecutor } from "./base.js";
import { CODEX_DEFAULT_INSTRUCTIONS } from "../config/codexInstructions.js";
import { PROVIDERS } from "../config/providers.js";
import {
  refreshProviderCredentials,
  shouldRefreshCredentials,
} from "../services/oauthCredentialManager.js";
import { normalizeResponsesInput } from "../translator/formats/responsesApi.js";
import { fetchImageAsBase64 } from "../translator/concerns/image.js";
import { getModelUpstreamId } from "../config/providerModels.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import {
  HTTP_STATUS,
  resolveOverloadDelayMs,
  resolveOverloadRetryConfig,
} from "../config/runtimeConfig.js";
import { dbg } from "../utils/debugLog.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { stripCodexUnsupportedPatterns } from "../utils/codexToolSchema.js";

// SSE error patterns inside 200-OK bodies. Some retry same account first; capacity rotates accounts.
// The generic OpenAI 500 blurb ("An error occurred while processing your request…
// help.openai.com…") sometimes arrives inside a 200-OK stream instead of an HTTP
// 5xx status; without matching it here it would stream straight to the client.
const CODEX_SSE_RETRY_PATTERNS = [
  "server_is_overloaded",
  "service_unavailable_error",
  "our servers are currently overloaded",
  "an error occurred while processing your request",
];
const CODEX_SSE_ACCOUNT_FALLBACK_PATTERNS = ["selected model is at capacity", "model_at_capacity"];
const CODEX_SSE_USER_OUTPUT_PATTERNS = [
  "event: response.output_text.delta",
  "event: response.function_call_arguments.delta",
  '"type":"response.output_text.delta"',
  '"type":"response.function_call_arguments.delta"',
];
const CODEX_SSE_PEEK_BYTES = 256 * 1024;
// A capacity/overload rejection is not always the first frame: Codex can stream a
// few output deltas and only then fail the turn. Breaking out on the first delta
// (the previous behaviour) let that error through as a 200-OK stream, so the combo
// accepted it as a success and never rotated to the next model — the overload was
// reported to the client instead of being routed around.
//
// After the first delta the scan used to stop after a FIXED 150ms. That is shorter
// than the gap between a first delta and the overload frame in the failing case:
// measured on production, a turn can emit a couple of deltas and only then report
// `server_is_overloaded`. A fixed window therefore leaked the error frame to the
// client as a normal stream (recorded as success, no retry, no log line).
//
// The window is now CONTENT-AWARE instead of fixed: after the first delta, keep
// scanning until the turn has produced a substantial amount of output (a healthy
// turn reaches this in milliseconds, so the common case pays almost no extra
// time-to-first-token), or until the hard caps below. A short burst of deltas
// followed by an error — the failure shape — stays under both the character and
// byte thresholds and is scanned long enough to catch the frame.
//
//   _CHARS — output text accumulated before the scan may stop
//   _MS    — hard ceiling on the post-output scan, so a slow upstream cannot
//            hold the stream open indefinitely
//   _BYTES — byte ceiling on the buffered prefix, independent of the char count
// SPRING_MOUSE_CODEX_SSE_GRACE_MS=0 restores the old fast path (stop at the
// first delta).
const CODEX_SSE_OUTPUT_GRACE_MS = (() => {
  const raw = process.env.SPRING_MOUSE_CODEX_SSE_GRACE_MS;
  if (raw == null || raw === "") return 2000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2000;
})();
// Output characters that end the post-output scan. A healthy turn emits far more
// than this within the first few frames, so normal streaming is not delayed.
const CODEX_SSE_OUTPUT_GRACE_CHARS = (() => {
  const raw = process.env.SPRING_MOUSE_CODEX_SSE_GRACE_CHARS;
  if (raw == null || raw === "") return 200;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 200;
})();
const CODEX_SSE_OUTPUT_GRACE_BYTES = 16 * 1024;
// Once a terminal frame is seen the turn already ended normally; no later frame can
// turn it into a retryable error, so the scan stops buffering immediately.
const CODEX_SSE_TERMINAL_PATTERNS = ["response.completed", "response.done", "data: [done]"];
const CODEX_MODEL_CAPACITY_MESSAGE = "Selected model is at capacity. Please try a different model.";

// Server-generated item id prefixes that Codex /responses cannot resolve when store=false
const SERVER_ID_PATTERN = /^(rs|fc|resp|msg)_/;

// Hosted tool types that Codex/OpenAI Responses executes server-side
const CODEX_HOSTED_TOOL_TYPES = new Set([
  "image_generation", "web_search", "web_search_preview", "file_search",
  "computer", "computer_use_preview", "code_interpreter", "mcp", "local_shell",
  "tool_search"
]);

// Responses-native freeform tools carry a name plus format payload and must pass through intact.
const CODEX_PASSTHROUGH_TOOL_TYPES = new Set(["custom"]);

// Allowlist of fields accepted by Codex Responses API — anything else is stripped
const RESPONSES_API_ALLOWLIST = new Set([
  "model", "input", "instructions", "tools", "tool_choice", "stream", "store",
  "reasoning", "service_tier", "include", "prompt_cache_key", "client_metadata",
  "text"
]);

// Convert role=system → role=developer in body.input (keeps content in cacheable prefix)
function convertSystemToDeveloperRole(body) {
  if (!Array.isArray(body.input)) return;
  for (const item of body.input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const isSystemMsg = item.role === "system" && (!item.type || item.type === "message");
    if (isSystemMsg) item.role = "developer";
  }
}

// Strip server-generated item IDs (rs_/fc_/resp_/msg_) from input — avoids 404 with store=false
function stripStoredItemReferences(body) {
  if (!Array.isArray(body.input)) return;
  body.input = body.input.filter((item) => {
    if (typeof item === "string" && SERVER_ID_PATTERN.test(item)) return false;
    if (item && typeof item === "object" && !Array.isArray(item)) {
      if (item.type === "item_reference") return false;
      if (typeof item.id === "string" && SERVER_ID_PATTERN.test(item.id)) delete item.id;
    }
    return true;
  });
}

// Flatten Chat-Completions tool shape into Responses flat format + filter unsupported tools
function normalizeCodexTools(body) {
  if (!Array.isArray(body.tools)) return;
  const validNames = new Set();
  const patternStats = { removed: 0 };
  body.tools = body.tools.filter((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
    const type = typeof tool.type === "string" ? tool.type : "";
    if (type === "namespace") {
      if (Array.isArray(tool.tools)) {
        for (const st of tool.tools) {
          const n = typeof st?.name === "string" ? st.name.trim().slice(0, 128) : "";
          if (n) validNames.add(n);
          if (st?.parameters && typeof st.parameters === "object") {
            st.parameters = stripCodexUnsupportedPatterns(st.parameters, patternStats);
          }
        }
      }
      return true;
    }
    if (type !== "function") {
      if (CODEX_PASSTHROUGH_TOOL_TYPES.has(type)) return true;
      if (!type || tool.function || typeof tool.name === "string") return false;
      return CODEX_HOSTED_TOOL_TYPES.has(type);
    }
    const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function) ? tool.function : null;
    const rawName = typeof tool.name === "string" ? tool.name : (typeof fn?.name === "string" ? fn.name : "");
    const name = rawName.trim();
    if (!name) return false;
    const description = typeof tool.description === "string" ? tool.description : (typeof fn?.description === "string" ? fn.description : "");
    const parameters = (tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters))
      ? tool.parameters
      : (fn?.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters) ? fn.parameters : { type: "object", properties: {} });
    for (const k of Object.keys(tool)) delete tool[k];
    tool.type = "function";
    tool.name = name.slice(0, 128);
    if (description) tool.description = description;
    tool.parameters = stripCodexUnsupportedPatterns(parameters, patternStats);
    validNames.add(name);
    return true;
  });
  if (patternStats.removed > 0) {
    dbg("CODEX", `stripped ${patternStats.removed} unsupported tool schema pattern(s)`);
  }
  // Drop tool_choice if it references an unknown function name
  if (body.tool_choice && typeof body.tool_choice === "object" && !Array.isArray(body.tool_choice)) {
    if (body.tool_choice.type === "function") {
      const n = typeof body.tool_choice.name === "string" ? body.tool_choice.name.trim() : "";
      if (!n || !validNames.has(n)) delete body.tool_choice;
    }
  }
}

// Resolve prompt-cache session id: client session → assistant-text-hash → workspaceId → connection
function resolveCacheSessionId(body, credentials) {
  return resolveSessionId({
    headers: credentials?.rawHeaders,
    body,
    connectionId: credentials?.connectionId,
    workspaceId: credentials?.providerSpecificData?.workspaceId,
    scope: "codex"
  });
}

function normalizeReasoningEffort(model, value) {
  const supportedLevels = getThinkingLevels("codex", model);
  if (supportedLevels?.includes(value)) return value;
  if (value === "ultra" && supportedLevels?.includes("max")) return "max";
  if (value === "max" || value === "ultra") return "xhigh";
  return value;
}

function findNestedMessage(value, depth = 0) {
  if (!value || depth > 6 || typeof value === "string") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  if (typeof value.message === "string" && value.message.trim()) return value.message;
  if (typeof value.error?.message === "string" && value.error.message.trim()) return value.error.message;
  if (typeof value.response?.error?.message === "string" && value.response.error.message.trim()) return value.response.error.message;
  for (const child of Object.values(value)) {
    const found = findNestedMessage(child, depth + 1);
    if (found) return found;
  }
  return null;
}

// Concatenate only the payloads of *error* frames (`event: error` / `response.failed`)
// from an SSE buffer, in their original case. Pattern matching and message extraction
// must run against this, not the raw stream: the model's own output text also travels
// as SSE data, and a reply that merely quotes an error string (very likely when the
// user is debugging this exact message) must not be mistaken for an upstream failure.
//
// A `data:` line is treated as an error payload when it sits inside an error frame
// or when its JSON carries a top-level `error` object — the latter covers upstreams
// that omit the `event:` line. A cheap substring gate keeps JSON.parse off the hot
// path for ordinary output deltas.
function errorFramePayloads(text) {
  const out = [];
  let inError = false;
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("event:")) {
      const name = trimmed.slice(6).trim();
      inError = name === "error" || name === "response.failed";
      continue;
    }
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    if (inError) { out.push(payload); continue; }
    if (!payload.includes('"error"')) continue;
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === "object" && parsed.error) out.push(payload);
    } catch {
      // Not a JSON error payload — ignore.
    }
  }
  return out;
}

// Human-readable duration for log lines: "1.5s" / "90s" / "300ms". A sub-second
// budget is legal (the tests use one) and would otherwise log as "0s".
function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
}

// Count the visible output text in an SSE buffer, from `from` onward. Only complete
// lines are consumed so a half-received frame is not miscounted; the index of the
// first incomplete line is returned as the new cursor. Used by the content-aware
// post-output scan to tell "a healthy turn is streaming" (stop scanning) from "a
// couple of deltas then a rejection" (keep scanning).
function countOutputText(text, from = 0) {
  let count = 0;
  let cursor = from;
  while (true) {
    const nl = text.indexOf("\n", cursor);
    if (nl === -1) break;
    const line = text.slice(cursor, nl).trim();
    cursor = nl + 1;
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]" || !payload.includes('"delta"')) continue;
    try {
      const parsed = JSON.parse(payload);
      const delta = parsed?.delta;
      if (typeof delta === "string") count += delta.length;
    } catch {
      // Not a JSON delta — ignore.
    }
  }
  return { count, cursor };
}

// Pull the human-readable message out of an SSE error payload. Only error frames are
// inspected, for the reason documented on errorFramePayloads.
function extractSseErrorMessage(text, fallback) {
  const payloads = errorFramePayloads(text);
  if (payloads.length === 0) return fallback || CODEX_MODEL_CAPACITY_MESSAGE;

  for (const data of payloads) {
    const exact = data.match(/Selected model is at capacity\. Please try a different model\./i)?.[0];
    if (exact) return exact;
    try {
      const message = findNestedMessage(JSON.parse(data));
      if (message) return message;
    } catch {
      // Ignore non-JSON SSE data lines.
    }
  }

  return fallback || CODEX_MODEL_CAPACITY_MESSAGE;
}

// Retry-After advertised by the upstream response, in ms, clamped so a hostile or
// buggy value cannot park a request slot for hours.
function upstreamRetryAfterMs(response) {
  const raw = response?.headers?.get?.("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  const dateMs = new Date(raw).getTime();
  return Number.isFinite(dateMs) ? Math.max(0, Math.min(dateMs - Date.now(), 30_000)) : null;
}

/**
 * Build the client-facing 503 for an error that arrived *inside* a 200-OK SSE
 * stream. The status code deliberately stays 503 (clients already handle it), but
 * the original in-stream payload is attached to the response object so chatCore
 * can record it. Without that attachment the raw upstream body was thrown away
 * and every such failure was indistinguishable from a real upstream HTTP 503.
 */
function codexSseErrorResponse(status, message, origin = null, upstreamError = null) {
  const response = new Response(JSON.stringify({
    error: {
      message,
      type: status >= 500 ? "server_error" : "invalid_request_error",
      code: status === HTTP_STATUS.SERVICE_UNAVAILABLE ? "service_unavailable" : "upstream_error",
    }
  }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
  const evidence = upstreamError || {
    source: "sse",
    status,
    message,
    body: "",
    retryAfterMs: null,
    receivedAt: new Date().toISOString(),
  };
  // `layer: "provider"` is stated explicitly: the condition originated upstream,
  // spring-mouse only translated the transport (SSE event → HTTP status).
  response.__smUpstreamError = { ...evidence, origin, layer: "provider" };
  return response;
}

/**
 * Codex Executor - handles OpenAI Codex API (Responses API format)
 * Automatically injects default instructions if missing
 */
export class CodexExecutor extends BaseExecutor {
  constructor() {
    super("codex", PROVIDERS.codex);
    // Upstream overload arrives as a 200-OK SSE error event, so this budget is
    // the only same-account retry the request gets before accounts rotate. One
    // attempt with a 1s delay gave a saturated upstream a single second to
    // recover, which is why almost every overload surfaced to the client as a
    // 503. Two attempts with jitter ride out the short bursts instead.
    this.config = { ...PROVIDERS.codex, retry: { ...(PROVIDERS.codex?.retry || {}), 503: { attempts: 2, delayMs: 1500 } } };
    this._currentSessionId = null;
  }

  /**
   * Override headers to add codex-specific identity headers.
   * transformRequest runs BEFORE buildHeaders, sets this._currentSessionId.
   */
  buildHeaders(credentials, stream = true) {
    const headers = super.buildHeaders(credentials, stream);
    headers["session_id"] = this._currentSessionId || credentials?.connectionId || "default";
    // Identify client type to Codex backend (matches official codex CLI)
    if (!headers["originator"]) headers["originator"] = "codex_cli_rs";
    // Account/workspace binding header — required when multiple Codex accounts
    // are configured. OAuth import stores ChatGPT account ID as chatgptAccountId;
    // older/custom rows may use workspaceId/accountId. Prefer explicit workspaceId
    // but fall back to chatgptAccountId so requests don't cross-bind to the wrong
    // OpenAI account and surface as token_invalid after adding another account.
    const accountId =
      credentials?.providerSpecificData?.workspaceId ||
      credentials?.providerSpecificData?.chatgptAccountId ||
      credentials?.providerSpecificData?.accountId;
    if (typeof accountId === "string" && accountId && !headers["ChatGPT-Account-ID"]) {
      headers["ChatGPT-Account-ID"] = accountId;
    }
    return headers;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    const base = super.buildUrl(model, stream, urlIndex, credentials);
    return this._isCompact ? `${base}/compact` : base;
  }

  async refreshCredentials(credentials, log) {
    if (!credentials?.refreshToken) return null;
    return refreshProviderCredentials("codex", credentials, log);
  }

  needsRefresh(credentials) {
    return shouldRefreshCredentials("codex", credentials);
  }

  /**
   * Prefetch remote image URLs and inline them as base64 data URIs.
   * Runs before execute() because Codex backend cannot fetch remote images.
   * Mutates body.input in place.
   */
  async prefetchImages(body) {
    if (!Array.isArray(body?.input)) return;
    for (const item of body.input) {
      if (!Array.isArray(item.content)) continue;
      const pending = item.content.map(async (c) => {
        if (c.type !== "image_url") return c;
        const url = typeof c.image_url === "string" ? c.image_url : c.image_url?.url;
        const detail = c.image_url?.detail || "auto";
        if (!url) return c;
        if (url.startsWith("data:")) return { type: "input_image", image_url: url, detail };
        const fetched = await fetchImageAsBase64(url, { timeoutMs: 15000 });
        return { type: "input_image", image_url: fetched?.url || url, detail };
      });
      item.content = await Promise.all(pending);
    }
  }

  async execute(args) {
    const imgCount = Array.isArray(args.body?.input) ? args.body.input.reduce((n, it) => n + (Array.isArray(it.content) ? it.content.filter(c => c.type === "image_url").length : 0), 0) : 0;
    const inputLen = Array.isArray(args.body?.input) ? args.body.input.length : 0;
    dbg("CODEX", `execute start | inputItems=${inputLen} | images=${imgCount} | sessionId=${this._currentSessionId || "pending"}`);
    if (imgCount > 0) {
      const t0 = Date.now();
      await this.prefetchImages(args.body);
      dbg("CODEX", `prefetchImages done | ${Date.now() - t0}ms`);
    } else {
      await this.prefetchImages(args.body);
    }

    // Retry loop for SSE-level overloaded errors (200 OK body contains event: error).
    //
    // This is a TIME budget, not an attempt count. An upstream attempt on a real
    // prompt costs 10-30s before the overload frame arrives (~18s average on
    // production), so a fixed 1.5s backoff was shorter than the attempt it was
    // backing off from: every retry landed inside the same saturation window and
    // the request failed after ~55s of retrying that could never have worked.
    // The window is short — the same account succeeds again within the same
    // minute — so the loop now waits long enough to outlast it, bounded by a
    // budget that stays well under the 165s TTFT Codex clients tolerate.
    // Precedence: the channel's strategy entry (dashboard-tunable, per provider)
    // wins over the executor's own config, which wins over the built-in defaults.
    const overloadRetry = resolveOverloadRetryConfig(args.credentials?.providerStrategy, this.config.overloadRetry);
    const { budgetMs, minRetries, maxAttempts, minSleepMs } = overloadRetry;
    // The per-model budget is capped by the caller's request-wide deadline: a combo
    // whose members all reach the same saturated upstream must not spend a fresh
    // 90s per model (measured: the GPT chain has 3-6 such models). Past that
    // deadline `minRetries` is dropped to 0 as well, so a late model fails fast and
    // hands control to the combo instead of extending the request again.
    const sharedDeadline = Number.isFinite(args.overloadDeadline) ? args.overloadDeadline : Infinity;
    const deadline = Math.min(Date.now() + budgetMs, sharedDeadline);
    const effectiveMinRetries = Date.now() >= sharedDeadline ? 0 : minRetries;
    let attempt = 0;
    // Announce the budget once, before the first retry, so an overload is legible
    // from its first line: what was matched, how long we are willing to wait, and
    // which deadline applies. Without it the log opens mid-story on "retry 1".
    let announced = false;
    while (true) {
      const result = await super.execute(args);
      const peek = await this._peekSseTransientError(result.response);
      if (!peek.matched) {
        // Recovery: the retries outlasted the saturation window. Worth a line of its
        // own — without it the log shows "retry 1 … retry 2 …" and then nothing, so a
        // request that RECOVERED is indistinguishable from one that died mid-retry.
        if (attempt > 0) {
          args.log?.warn?.("RETRY", `CODEX | SSE overloaded — recovered after ${attempt} retr${attempt === 1 ? "y" : "ies"}`);
        }
        // Replace body with re-assembled stream (prefix bytes already read + rest)
        if (peek.replacementBody) {
          result.response = new Response(peek.replacementBody, {
            status: result.response.status,
            statusText: result.response.statusText,
            headers: result.response.headers,
          });
        }
        return result;
      }
      if (peek.accountFallback) {
        args.log?.warn?.("RETRY", `CODEX | SSE account fallback "${peek.message}"`);
        result.response = codexSseErrorResponse(
          HTTP_STATUS.SERVICE_UNAVAILABLE, peek.message || CODEX_MODEL_CAPACITY_MESSAGE, "model_at_capacity", peek.upstreamError);
        return result;
      }
      // Keep retrying while the budget lasts, but always allow `minRetries` — a
      // single slow attempt must not be able to spend the whole budget and leave
      // the request with no retry at all. `maxAttempts` is a hard ceiling so a
      // malformed config cannot loop forever.
      const withinBudget = Date.now() < deadline;
      const exhausted = (attempt >= effectiveMinRetries && !withinBudget) || attempt >= maxAttempts;
      if (exhausted) {
        args.log?.warn?.("RETRY", `CODEX | SSE overloaded "${peek.matched}" — retries exhausted (${attempt} retr${attempt === 1 ? "y" : "ies"}, ${fmtDuration(budgetMs)} budget)`);
        result.response = codexSseErrorResponse(
          HTTP_STATUS.SERVICE_UNAVAILABLE, peek.message || peek.matched, "sse_overload", peek.upstreamError);
        return result;
      }
      attempt++;
      // An upstream Retry-After, when present, wins over the local curve because
      // it is the only authoritative recovery estimate we get; otherwise the
      // delay grows exponentially. Full jitter keeps concurrent requests that all
      // observed the same overload event from waking in lockstep and re-creating
      // the very burst that overloaded the upstream.
      const upstreamDelayMs = Number.isFinite(peek.upstreamError?.retryAfterMs) && peek.upstreamError.retryAfterMs > 0
        ? peek.upstreamError.retryAfterMs
        : resolveOverloadDelayMs(attempt, overloadRetry);
      // Never sleep past the deadline: the remaining budget caps the wait, but
      // `minSleepMs` keeps the sleep meaningful instead of a zero-delay hot loop
      // against an upstream that is already saturated.
      const remainingMs = Math.max(0, deadline - Date.now());
      const targetMs = Math.min(upstreamDelayMs, Math.max(remainingMs, minSleepMs));
      const waitMs = Math.max(1, Math.round(targetMs * (0.5 + Math.random() * 0.5)));
      // WARN, not DEBUG: under the production LOG_LEVEL=WARN a debug line is invisible,
      // so the retry — the whole point of the overload budget — left no trace when it
      // succeeded, and only the exhaustion path was observable. Retries are rare and
      // operationally meaningful, so they belong at the level operators actually read.
      if (!announced) {
        announced = true;
        args.log?.warn?.("RETRY", `CODEX | SSE overloaded "${peek.matched}" — retrying within a ${fmtDuration(budgetMs)} budget`);
      }
      args.log?.warn?.("RETRY", `CODEX | SSE overloaded "${peek.matched}" — retry ${attempt} in ${fmtDuration(waitMs)} (budget left ${fmtDuration(remainingMs)})`);
      dbg("CODEX", `SSE overloaded "${peek.matched}" → retry ${attempt} in ${waitMs}ms`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }

  // Peek first N bytes of SSE body to detect upstream transient errors.
  // Returns { matched: string|null, message: string|null, accountFallback: boolean, replacementBody: ReadableStream|null }.
  // Caller must use replacementBody when no error matched (original body has been read).
  async _peekSseTransientError(response) {
    if (!response || !response.ok || !response.body) return { matched: null, message: null, accountFallback: false, replacementBody: null };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks = [];
    let text = "";
    let matched = null;
    let accountFallback = false;
    // Bounded post-output scan: see CODEX_SSE_OUTPUT_GRACE_MS. 0 disables it.
    const graceEnabled = CODEX_SSE_OUTPUT_GRACE_MS > 0;
    let graceDeadline = 0;
    let graceBytesAt = 0;
    // Output text produced so far (delta payloads only, framing excluded). The scan
    // stops once this reaches CODEX_SSE_OUTPUT_GRACE_CHARS, which a healthy turn
    // crosses in milliseconds. `countedUpTo` is how far into `text` complete lines
    // have already been counted, so the accounting is O(new bytes) per chunk.
    let outputChars = 0;
    let countedUpTo = 0;
    // A read that the grace deadline raced past is NOT abandoned: it is carried into
    // the reassembled stream below, so the same reader keeps serving the client and
    // no lock is left dangling.
    let pendingRead = null;
    try {
      while (text.length < CODEX_SSE_PEEK_BYTES) {
        const remainingMs = graceDeadline > 0 ? graceDeadline - Date.now() : 0;
        if (graceDeadline > 0 && remainingMs <= 0) break;
        if (!pendingRead) pendingRead = reader.read();
        // Once output has started, a silent upstream must not hold the request open:
        // race the read against the remaining grace budget so the stream can begin
        // flowing to the client even if the turn never completes.
        let result;
        if (graceDeadline > 0) {
          let graceTimer;
          result = await Promise.race([
            pendingRead,
            new Promise((resolve) => { graceTimer = setTimeout(() => resolve({ timedOut: true }), remainingMs); }),
          ]);
          clearTimeout(graceTimer);
        } else {
          result = await pendingRead;
        }
        if (result.timedOut) break; // pendingRead stays pending; handed off below
        pendingRead = null;
        const { done, value } = result;
        if (done) break;
        chunks.push(value);
        text += decoder.decode(value, { stream: true });
        // Match against error-frame payloads only (see errorFramePayloads): a normal
        // output delta that quotes an error string must not trigger a fallback.
        const errorText = errorFramePayloads(text).join("\n").toLowerCase();
        if (errorText) {
          const accountHit = CODEX_SSE_ACCOUNT_FALLBACK_PATTERNS.find(p => errorText.includes(p));
          if (accountHit) { matched = accountHit; accountFallback = true; break; }
          const retryHit = CODEX_SSE_RETRY_PATTERNS.find(p => errorText.includes(p));
          if (retryHit) { matched = retryHit; break; }
        }
        const lowerText = text.toLowerCase();
        if (CODEX_SSE_TERMINAL_PATTERNS.some(p => lowerText.includes(p))) break;
        // Content-aware post-output scan. Once the turn has produced a substantial
        // amount of text it is plainly a healthy stream, so stop buffering; a short
        // burst of deltas followed by a rejection stays under the threshold and keeps
        // the scan alive long enough to catch the frame. The char count is updated
        // incrementally from the last complete line to keep this O(new bytes).
        if (graceDeadline > 0) {
          const counted = countOutputText(text, countedUpTo);
          outputChars += counted.count;
          countedUpTo = counted.cursor;
          if (Date.now() >= graceDeadline
            || outputChars >= CODEX_SSE_OUTPUT_GRACE_CHARS
            || text.length - graceBytesAt >= CODEX_SSE_OUTPUT_GRACE_BYTES) break;
          continue;
        }
        if (CODEX_SSE_USER_OUTPUT_PATTERNS.some(p => lowerText.includes(p))) {
          // Output already started. Do not stop here: keep scanning so a same-turn
          // capacity/overload rejection still triggers fallback. The scan ends on the
          // first of: a terminal frame, enough output to prove the turn is healthy,
          // the byte cap, or the hard time ceiling — so a healthy stream is released
          // almost immediately while a short burst before a rejection is caught.
          if (!graceEnabled) break;
          graceDeadline = Date.now() + CODEX_SSE_OUTPUT_GRACE_MS;
          graceBytesAt = text.length;
          const counted = countOutputText(text, countedUpTo);
          outputChars += counted.count;
          countedUpTo = counted.cursor;
        }
      }
    } catch (e) {
      dbg("CODEX", `peek read error: ${e.message}`);
    }

    if (matched) {
      try { await reader.cancel(); } catch { /* noop */ }
      try { reader.releaseLock(); } catch { /* noop */ }
      const message = extractSseErrorMessage(text, matched);
      return {
        matched,
        message,
        accountFallback,
        replacementBody: null,
        upstreamError: {
          source: "sse",
          status: response.status,
          message,
          body: text.slice(0, 4000),
          retryAfterMs: upstreamRetryAfterMs(response),
          receivedAt: new Date().toISOString(),
        },
      };
    }

    // Re-assemble stream: prefix chunks + remaining upstream body. The SAME reader is
    // reused (never released) so a read the grace deadline interrupted is simply
    // awaited on the next pull instead of being lost.
    let carry = pendingRead;
    const replacementBody = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
      },
      async pull(controller) {
        try {
          const { done, value } = carry ? await carry : await reader.read();
          carry = null;
          if (done) { controller.close(); return; }
          controller.enqueue(value);
        } catch (e) { controller.error(e); }
      },
      cancel(reason) {
        try { reader.cancel(reason); } catch { /* noop */ }
      },
    });
    return { matched: null, message: null, accountFallback: false, replacementBody };
  }

  // Parse Codex usage_limit_reached to extract precise resetsAtMs; fallback to default otherwise
  parseError(response, bodyText) {
    if (response.status === 429 && bodyText) {
      try {
        const json = JSON.parse(bodyText);
        const err = json?.error;
        if (err?.type === "usage_limit_reached") {
          const now = Date.now();
          let resetsAtMs = null;
          if (typeof err.resets_at === "number" && err.resets_at > 0) {
            const ms = err.resets_at * 1000;
            if (ms > now) resetsAtMs = ms;
          }
          if (!resetsAtMs && typeof err.resets_in_seconds === "number" && err.resets_in_seconds > 0) {
            resetsAtMs = now + err.resets_in_seconds * 1000;
          }
          if (resetsAtMs) {
            return { status: 429, message: err.message || bodyText, resetsAtMs };
          }
        }
      } catch { /* fall through to default */ }
    }
    return super.parseError(response, bodyText);
  }

  /**
   * Transform request before sending - inject default instructions if missing.
   * Image fetching is handled separately in prefetchImages() so this stays sync.
   */
  transformRequest(model, body, stream, credentials) {
    this._isCompact = !!body._compact;
    delete body._compact;
    // Resolve conversation-stable session_id (priority: body → assistant-text → workspace → machine)
    this._currentSessionId = resolveCacheSessionId(body, credentials);
    // Convert string input to array format (Codex API requires input as array)
    const normalized = normalizeResponsesInput(body.input);
    if (normalized) body.input = normalized;

    // Ensure input is present and non-empty (Codex API rejects empty input)
    if (!body.input || (Array.isArray(body.input) && body.input.length === 0)) {
      body.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] }];
    }

    // Keep system prompts in body.input as role=developer so they stay in the cacheable prefix
    convertSystemToDeveloperRole(body);
    // Strip server-generated item IDs (rs_/fc_/resp_/msg_) — Codex /responses can't resolve when store=false
    stripStoredItemReferences(body);
    // Flatten function tools + drop unsupported types
    normalizeCodexTools(body);

    // Ensure streaming is enabled (Codex API requires it)
    body.stream = true;

    // If no instructions provided, inject default Codex instructions
    if (!body.instructions || body.instructions.trim() === "") {
      body.instructions = CODEX_DEFAULT_INSTRUCTIONS;
    }

    // Ensure store is false (Codex requirement)
    body.store = false;

    // Inject prompt_cache_key for stable Codex prompt caching
    if (!body.prompt_cache_key && this._currentSessionId) {
      body.prompt_cache_key = this._currentSessionId;
    }

    // Map virtual Codex review models to the upstream Codex model before suffix parsing.
    body.model = getModelUpstreamId("cx", body.model || model);

    // Extract thinking level from model name suffix
    // e.g., gpt-5.3-codex-high → high, gpt-5.3-codex → medium (default)
    const effortLevels = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
    let modelEffort = null;
    for (const level of effortLevels) {
      if (body.model.endsWith(`-${level}`)) {
        modelEffort = level;
        // Strip suffix from model name for actual API call
        body.model = body.model.replace(`-${level}`, '');
        break;
      }
    }

    // Priority: explicit reasoning.effort > reasoning_effort param > model suffix > default (medium)
    if (!body.reasoning) {
      const effort = normalizeReasoningEffort(body.model, body.reasoning_effort || modelEffort || 'low');
      body.reasoning = { effort, summary: "auto" };
    } else {
      body.reasoning.effort = normalizeReasoningEffort(body.model, body.reasoning.effort);
      if (!body.reasoning.summary) body.reasoning.summary = "auto";
    }
    delete body.reasoning_effort;

    // Include reasoning encrypted content (required by Codex backend for reasoning models)
    if (body.reasoning && body.reasoning.effort && body.reasoning.effort !== 'none') {
      body.include = ["reasoning.encrypted_content"];
    }

    // Remove unsupported parameters for Codex API
    delete body.temperature;
    delete body.top_p;
    delete body.frequency_penalty;
    delete body.presence_penalty;
    delete body.logprobs;
    delete body.top_logprobs;
    delete body.n;
    delete body.seed;
    delete body.max_tokens;
    delete body.max_completion_tokens;
    delete body.max_output_tokens; // Responses API clients send this but Codex rejects it
    delete body.user; // Cursor sends this but Codex doesn't support it
    delete body.prompt_cache_retention; // Cursor sends this but Codex doesn't support it
    delete body.metadata; // Cursor sends this but Codex doesn't support it
    delete body.stream_options; // Cursor sends this but Codex doesn't support it
    delete body.safety_identifier; // Droid CLI sends this but Codex doesn't support it
    delete body.previous_response_id; // store=false → backend can't resolve previous resp; avoid 404

    if (body.service_tier === "fast") body.service_tier = "priority";
    if (body.service_tier && body.service_tier !== "priority") delete body.service_tier;

    // Final allowlist filter — strip any unknown field that could trigger upstream "routing_unsupported"
    for (const k of Object.keys(body)) {
      if (!RESPONSES_API_ALLOWLIST.has(k)) delete body[k];
    }

    return body;
  }
}
