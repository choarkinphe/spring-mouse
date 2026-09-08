import { MEMORY_CONFIG } from "../config/runtimeConfig.js";

const sessionStartStore = new Map();
const MAX_SESSION_STARTS = 5000;
let retainedBytes = 0;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function sessionKey(connectionId, conversationId) {
  return `${connectionId || ""}:${conversationId || ""}`;
}

function ensureUserMessageModelId(message, modelId) {
  if (message?.userInputMessage && !message.userInputMessage.modelId && modelId) {
    message.userInputMessage.modelId = modelId;
  }
  return message;
}

function ensureHistoryModelIds(history, modelId) {
  for (const item of history || []) {
    ensureUserMessageModelId(item, modelId);
  }
  return history;
}

function prefixUserMessage(message, contentPrefix, modelId) {
  const out = clone(message) || { userInputMessage: { content: "" } };
  if (!out.userInputMessage) out.userInputMessage = { content: "" };
  ensureUserMessageModelId(out, modelId);
  if (contentPrefix) {
    const content = out.userInputMessage.content || "";
    out.userInputMessage.content = content
      ? `${contentPrefix}\n\n${content}`
      : contentPrefix;
  }
  return out;
}

function findFirstUserIndex(history) {
  return history.findIndex((item) => item?.userInputMessage);
}

function hasToolResults(message) {
  return !!message?.userInputMessage?.userInputMessageContext?.toolResults?.length;
}

function canReplaceSessionStart(history, firstUserIndex) {
  return firstUserIndex === 0 && !hasToolResults(history[firstUserIndex]);
}

function deleteSession(key) {
  const entry = sessionStartStore.get(key);
  if (!entry) return;
  retainedBytes -= entry.bytes;
  sessionStartStore.delete(key);
}

function rememberSessionStart(key, entry) {
  deleteSession(key);
  // Retain a detached serialized value, not another graph of prompt objects.
  // Oversized entries are simply not cached; the actual request is unchanged.
  const json = JSON.stringify(entry);
  const bytes = (json.length + key.length) * 2 + 128;
  if (bytes > MEMORY_CONFIG.kiroSessionMaxEntryBytes || bytes > MEMORY_CONFIG.kiroSessionMaxBytes) return;
  while (sessionStartStore.size && (sessionStartStore.size >= MAX_SESSION_STARTS || retainedBytes + bytes > MEMORY_CONFIG.kiroSessionMaxBytes)) {
    deleteSession(sessionStartStore.keys().next().value);
  }
  sessionStartStore.set(key, { json, bytes, lastUsed: Date.now() });
  retainedBytes += bytes;
}

function readSession(key) {
  const entry = sessionStartStore.get(key);
  if (!entry) return null;
  if (Date.now() - entry.lastUsed >= MEMORY_CONFIG.sessionTtlMs) {
    deleteSession(key);
    return null;
  }
  return { entry, value: JSON.parse(entry.json) };
}

/**
 * Preserve Kiro cacheability by freezing the first user message (`msg0`) for a
 * session, replaying that exact message as the first history user on later
 * turns, and injecting volatile current-time context only into the current turn.
 */
export function applyKiroSessionReplay({
  conversationId,
  connectionId,
  modelId,
  systemPrompt = "",
  contentPrefix = "",
  currentContentPrefix = "",
  history = [],
  currentMessage,
} = {}) {
  const key = sessionKey(connectionId, conversationId);
  const cached = conversationId ? readSession(key) : null;
  const existing = cached?.value;
  const baseHistory = clone(history) || [];
  const baseCurrent = clone(currentMessage) || { userInputMessage: { content: "" } };

  if (existing && existing.modelId === modelId && existing.systemPrompt === systemPrompt) {
    cached.entry.lastUsed = Date.now();
    sessionStartStore.delete(key);
    sessionStartStore.set(key, cached.entry);
    const firstUserIndex = findFirstUserIndex(baseHistory);
    const sessionStart = ensureUserMessageModelId(existing.sessionStart, modelId);
    if (canReplaceSessionStart(baseHistory, firstUserIndex)) {
      baseHistory[firstUserIndex] = sessionStart;
    } else {
      baseHistory.unshift(sessionStart);
      if (baseHistory.length === 1) {
        baseHistory.push({ assistantResponseMessage: { content: "..." } });
      }
    }
    return {
      history: ensureHistoryModelIds(baseHistory, modelId),
      currentMessage: prefixUserMessage(baseCurrent, currentContentPrefix, modelId),
      replayed: true,
    };
  }

  const firstUserIndex = findFirstUserIndex(baseHistory);
  let sessionStart;
  let nextCurrent = ensureUserMessageModelId(baseCurrent, modelId);
  if (canReplaceSessionStart(baseHistory, firstUserIndex)) {
    sessionStart = prefixUserMessage(baseHistory[firstUserIndex], contentPrefix, modelId);
    baseHistory[firstUserIndex] = clone(sessionStart);
    nextCurrent = prefixUserMessage(baseCurrent, currentContentPrefix, modelId);
  } else if (firstUserIndex >= 0) {
    sessionStart = prefixUserMessage(
      { userInputMessage: { content: "", modelId } },
      contentPrefix,
      modelId
    );
    baseHistory.unshift(clone(sessionStart));
    nextCurrent = prefixUserMessage(baseCurrent, currentContentPrefix, modelId);
  } else {
    sessionStart = prefixUserMessage(baseCurrent, contentPrefix, modelId);
    nextCurrent = clone(sessionStart);
  }

  if (conversationId) {
    rememberSessionStart(key, {
      sessionStart,
      modelId,
      systemPrompt,
    });
  }

  return {
    history: ensureHistoryModelIds(baseHistory, modelId),
    currentMessage: nextCurrent,
    replayed: false,
  };
}

export function clearKiroSessionReplayStore() {
  sessionStartStore.clear();
  retainedBytes = 0;
}

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of sessionStartStore) {
    if (now - entry.lastUsed >= MEMORY_CONFIG.sessionTtlMs) deleteSession(key);
  }
}, MEMORY_CONFIG.sessionCleanupIntervalMs);
if (cleanup.unref) cleanup.unref();

export const __test__ = { cacheStats: () => ({ entries: sessionStartStore.size, bytes: retainedBytes }) };
