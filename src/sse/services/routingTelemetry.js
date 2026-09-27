import { randomUUID } from "node:crypto";

// The producer is deliberately optional. Routing must remain load-bearing only
// for the client response; telemetry can be absent during an older deploy or a
// local test. Events emitted while it loads are bounded and flushed in order.
const PENDING_LIMIT = 256;
const VALID_ROLES = new Set(["primary", "panel", "judge", "classifier", "autoCandidate", "other"]);
const VALID_OUTCOMES = new Set(["valid_terminal", "failed", "cancelled", "incomplete", "unknown"]);
const VALID_STRATEGIES = new Set(["single", "fallback", "round-robin", "auto", "fusion", "unknown"]);
const VALID_REASONS = new Set([
  "invalid_json", "auth_rejected", "missing_model", "access_denied", "unsupported_capability",
  "bypass", "queue_timeout", "breaker_open", "model_overloaded", "account_locked", "no_account",
  "accounts_exhausted", "transport_error", "upstream_http_error", "internal_error", "client_abort",
  "model_fallback", "account_fallback", "response_unobserved", "stream_error", "output_error",
  "terminal", "upstream_error", "incomplete", "parse_error", "response_error", "unknown",
]);

let producer = null;
let producerLoad = null;
const pending = [];

function loadProducer() {
  if (producerLoad) return producerLoad;
  producerLoad = import("@/lib/redis/routingEvents.js")
    .then((module) => {
      producer = module;
      while (pending.length) {
        const event = pending.shift();
        try { module.enqueueRoutingEvent?.(event.entity, event.action, event.record); } catch { /* fail-open */ }
      }
      return module;
    })
    .catch(() => null);
  return producerLoad;
}

void loadProducer();

function emit(entity, action, record) {
  try {
    if (!record?.routingRequestId) return;
    if (typeof producer?.enqueueRoutingEvent === "function") {
      producer.enqueueRoutingEvent(entity, action, record);
      return;
    }
    if (pending.length < PENDING_LIMIT) pending.push({ entity, action, record });
  } catch {
    // Observability is fail-open by design.
  }
}

function id() {
  try { return randomUUID(); } catch { return null; }
}

function enumValue(set, value, fallback) {
  return typeof value === "string" && set.has(value) ? value : fallback;
}

function nonNegative(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function status(value) {
  const n = nonNegative(value);
  return n !== null && n >= 100 ? n : null;
}

function safeTimestamp(value, fallback) {
  const parsed = value ? new Date(value) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback;
}

function safeId(value) {
  return typeof value === "string" && value ? value : null;
}

function safeText(value, max = 256) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).replace(/[\x00-\x1f\x7f]/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

function normalizeReason(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  return enumValue(VALID_REASONS, value, "unknown");
}

function normalizeOutcome(value, fallback = "unknown") {
  return enumValue(VALID_OUTCOMES, value, fallback);
}

function normalizeRole(value) {
  return enumValue(VALID_ROLES, value, "primary");
}

function normalizeStrategy(value) {
  return enumValue(VALID_STRATEGIES, value, "unknown");
}

function normalizeObserverInfo(info = {}) {
  const usage = info?.usage && typeof info.usage === "object" ? info.usage : {};
  return {
    sourceFormat: safeText(info.sourceFormat, 64),
    targetFormat: safeText(info.targetFormat, 64),
    streamMode: safeText(info.streamMode, 32),
    nativePassthrough: info.nativePassthrough === true ? 1 : 0,
    upstreamStatus: status(info.upstreamStatus ?? info.status),
    ttftMs: nonNegative(info.ttftMs),
    durationMs: nonNegative(info.durationMs),
    promptTokens: nonNegative(info.promptTokens ?? usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokenCount),
    completionTokens: nonNegative(info.completionTokens ?? usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokenCount),
  };
}

function reasonForStatus(value) {
  const code = Number(value);
  if (code === 401 || code === 403) return "auth_rejected";
  if (code === 404) return "no_account";
  if (code === 429) return "account_locked";
  if (code >= 500) return "upstream_http_error";
  if (code >= 400) return "internal_error";
  return "unknown";
}

export function attemptTerminalFromResult(result, { fallbackReason = null } = {}) {
  const upstreamStatus = status(result?.upstreamStatus ?? result?.status);
  if (result?.success) {
    return { outcome: "valid_terminal", terminalReason: "terminal", upstreamStatus: upstreamStatus || 200 };
  }
  if (upstreamStatus === 499) {
    return { outcome: "cancelled", terminalReason: "client_abort", upstreamStatus, fallbackReason };
  }
  if (result?.upstreamError?.origin === "sse_overload") {
    return { outcome: "failed", terminalReason: "model_overloaded", upstreamStatus, fallbackReason };
  }
  if (result?.upstreamError?.layer === "network") {
    return { outcome: "failed", terminalReason: "transport_error", upstreamStatus, fallbackReason };
  }
  return {
    outcome: "failed",
    terminalReason: reasonForStatus(upstreamStatus),
    upstreamStatus,
    fallbackReason,
  };
}

export function requestTerminalFromResponse(response, reason = null) {
  const upstreamStatus = status(response?.status);
  if (upstreamStatus >= 200 && upstreamStatus < 300) {
    return { outcome: "valid_terminal", terminalReason: reason || "terminal", upstreamStatus };
  }
  if (upstreamStatus === 499) return { outcome: "cancelled", terminalReason: reason || "client_abort", upstreamStatus };
  return { outcome: "failed", terminalReason: reason || reasonForStatus(upstreamStatus) };
}

/**
 * Owns one external request's request row and all concrete account attempts.
 * Request completion is intentionally latched only after the selected final
 * attempt observes its protocol terminal. Failed fallback attempts can finish
 * earlier without settling the parent row.
 */
export function createRoutingTelemetrySession({ endpoint = null, trafficRequestId = null, startedAt = new Date().toISOString() } = {}) {
  const routingRequestId = id();
  const attempts = new Set();
  const responseAttempts = new WeakMap();
  const state = {
    opened: false,
    completed: false,
    startedAt: safeTimestamp(startedAt, new Date().toISOString()),
    originalModel: null,
    endpoint: safeText(endpoint, 160),
    trafficRequestId: safeId(trafficRequestId),
    requestType: null,
    strategy: "single",
    comboName: null,
    autoSource: null,
    autoLevel: null,
    autoConfidence: null,
    terminalReason: null,
    selectedAttempt: null,
    primaryAttempts: 0,
  };

  const session = {
    routingRequestId,
    get completed() { return state.completed; },
    get attemptCount() { return state.primaryAttempts; },
    open(record = {}) {
      if (!routingRequestId || state.opened) return;
      state.opened = true;
      session.hint(record);
      emit("request", "upsert", {
        routingRequestId,
        modelCallId: null,
        trafficRequestId: state.trafficRequestId,
        originalModel: state.originalModel,
        endpoint: state.endpoint,
        role: "primary",
        requestType: state.requestType,
        comboName: state.comboName,
        strategy: state.strategy,
        startedAt: state.startedAt,
        outcome: "unknown",
      });
    },
    hint(record = {}) {
      if (record.originalModel !== undefined) state.originalModel = safeText(record.originalModel);
      if (record.endpoint !== undefined) state.endpoint = safeText(record.endpoint, 160);
      if (record.trafficRequestId !== undefined) state.trafficRequestId = safeId(record.trafficRequestId);
      if (record.requestType !== undefined) state.requestType = safeText(record.requestType, 64);
      if (record.comboName !== undefined) state.comboName = safeText(record.comboName, 128);
      if (record.strategy !== undefined) state.strategy = normalizeStrategy(record.strategy);
      if (record.autoSource !== undefined) state.autoSource = ["default", "classifier", "manual", "unknown"].includes(record.autoSource) ? record.autoSource : "unknown";
      if (record.autoLevel !== undefined) state.autoLevel = safeText(record.autoLevel, 64);
      if (record.autoConfidence !== undefined) state.autoConfidence = Number.isFinite(Number(record.autoConfidence)) ? Number(record.autoConfidence) : null;
    },
    setTerminalReason(reason) {
      const normalized = normalizeReason(reason);
      if (normalized) state.terminalReason = normalized;
    },
    openAttempt(fields = {}) {
      const attemptId = id();
      if (!routingRequestId || !attemptId) return { id: null, bindResponse() {}, complete() {}, observer: null, isSettled: () => true };
      const role = normalizeRole(fields.role);
      const internal = fields.internal === true || fields.internalRequest === true;
      const attempt = {
        attemptId,
        routingRequestId,
        modelCallId: safeId(fields.modelCallId),
        role,
        provider: safeText(fields.provider, 96),
        model: safeText(fields.model),
        connectionId: safeId(fields.connectionId),
        routeIndex: nonNegative(fields.routeIndex),
        candidateIndex: nonNegative(fields.candidateIndex),
        sourceFormat: safeText(fields.sourceFormat, 64),
        targetFormat: safeText(fields.targetFormat, 64),
        nativePassthrough: fields.nativePassthrough === true ? 1 : 0,
        streamMode: safeText(fields.streamMode, 32),
        startedAt: new Date().toISOString(),
        completed: false,
        response: null,
        header: {},
        terminal: null,
        onSettled: (settled) => {
          if (state.selectedAttempt === settled && !state.completed) session.complete(settled.terminal);
        },
      };
      attempts.add(attempt);
      if (!internal && role === "primary") state.primaryAttempts += 1;

      const upsert = {
        attemptId,
        routingRequestId,
        modelCallId: attempt.modelCallId,
        role,
        provider: attempt.provider,
        model: attempt.model,
        connectionId: attempt.connectionId,
        routeIndex: attempt.routeIndex,
        candidateIndex: attempt.candidateIndex,
        sourceFormat: attempt.sourceFormat,
        targetFormat: attempt.targetFormat,
        nativePassthrough: attempt.nativePassthrough,
        streamMode: attempt.streamMode,
        startedAt: attempt.startedAt,
        outcome: "unknown",
      };
      emit("attempt", "upsert", upsert);

      const complete = (record = {}) => {
        if (attempt.completed) return;
        attempt.completed = true;
        const observed = normalizeObserverInfo({ ...attempt.header, ...record });
        const terminal = {
          outcome: normalizeOutcome(record.outcome),
          terminalReason: normalizeReason(record.terminalReason, null),
          fallbackReason: normalizeReason(record.fallbackReason, null),
          upstreamStatus: observed.upstreamStatus,
          ttftMs: observed.ttftMs,
          durationMs: observed.durationMs ?? nonNegative(Date.now() - Date.parse(attempt.startedAt)),
          promptTokens: observed.promptTokens,
          completionTokens: observed.completionTokens,
        };
        attempt.terminal = terminal;
        emit("attempt", "complete", {
          attemptId,
          routingRequestId,
          modelCallId: attempt.modelCallId,
          role,
          provider: attempt.provider,
          model: attempt.model,
          connectionId: attempt.connectionId,
          routeIndex: attempt.routeIndex,
          candidateIndex: attempt.candidateIndex,
          sourceFormat: observed.sourceFormat || attempt.sourceFormat,
          targetFormat: observed.targetFormat || attempt.targetFormat,
          nativePassthrough: observed.nativePassthrough || attempt.nativePassthrough,
          streamMode: observed.streamMode || attempt.streamMode,
          startedAt: attempt.startedAt,
          completedAt: new Date().toISOString(),
          ...terminal,
        });
        try { attempt.onSettled?.(attempt); } catch { /* fail-open */ }
      };

      const observer = {
        onHeaders(info = {}) {
          if (attempt.completed) return;
          attempt.header = { ...attempt.header, ...normalizeObserverInfo(info) };
          // Header status is useful even when a protocol callback omits it.
          if (attempt.header.upstreamStatus == null) attempt.header.upstreamStatus = status(info.status);
        },
        onTerminal(info = {}) {
          complete({ ...info, outcome: normalizeOutcome(info.outcome, "valid_terminal") });
        },
        onFailed(info = {}) {
          complete({ ...info, outcome: "failed", terminalReason: info.terminalReason || "upstream_error" });
        },
        onCancelled(info = {}) {
          complete({ ...info, outcome: "cancelled", terminalReason: info.terminalReason || "client_abort" });
        },
        onUnknown(info = {}) {
          complete({ ...info, outcome: "unknown", terminalReason: info.terminalReason || "unknown" });
        },
      };

      return {
        id: attemptId,
        observer,
        complete,
        bindResponse(response) {
          if (response && typeof response === "object") {
            attempt.response = response;
            responseAttempts.set(response, attempt);
          }
        },
        isSettled: () => attempt.completed,
        get terminal() { return attempt.terminal; },
        set onSettled(handler) { attempt.onSettled = handler; },
      };
    },
    finalize(response) {
      if (state.completed) return;
      if (!session.selectResponse(response)) session.complete(requestTerminalFromResponse(response, state.terminalReason));
    },
    selectResponse(response) {
      if (!response || typeof response !== "object") return false;
      const attempt = responseAttempts.get(response);
      if (!attempt) return false;
      state.selectedAttempt = attempt;
      if (attempt.completed) session.complete(attempt.terminal);
      return true;
    },
    completeFromResponse(response, reason = null) {
      if (state.completed || state.selectedAttempt) return;
      session.complete(requestTerminalFromResponse(response, reason || state.terminalReason));
    },
    complete(record = {}) {
      if (!routingRequestId || state.completed) return;
      state.completed = true;
      const terminal = record || {};
      emit("request", "complete", {
        routingRequestId,
        modelCallId: null,
        trafficRequestId: state.trafficRequestId,
        originalModel: state.originalModel,
        endpoint: state.endpoint,
        role: "primary",
        requestType: state.requestType,
        comboName: state.comboName,
        strategy: state.strategy,
        autoSource: state.autoSource,
        autoLevel: state.autoLevel,
        autoConfidence: state.autoConfidence,
        startedAt: state.startedAt,
        completedAt: new Date().toISOString(),
        outcome: normalizeOutcome(terminal.outcome),
        terminalReason: normalizeReason(terminal.terminalReason, null),
        attemptCount: state.primaryAttempts,
      });
    },
  };

  // A settled attempt only completes the parent when it is the response chosen
  // by combo/fusion. Failed fallback attempts therefore cannot win the parent.
  for (const attempt of attempts) attempt.onSettled = (settled) => {
    if (state.selectedAttempt === settled && !state.completed) session.complete(settled.terminal);
  };
  return session;
}

export const __test = Object.freeze({
  pending,
  normalizeObserverInfo,
  reasonForStatus,
});
