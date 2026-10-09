import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { deleteHotJson } from "@/lib/redis/hotCache.js";
import {
  CAPABILITY_TEST_SCOPE, CAPABILITY_HISTORY_LIMIT, CAPABILITY_TEST_LIMITS, CAPABILITY_EVIDENCE_TTL_MS,
} from "@/shared/constants/capabilityTests.js";

export function capabilityProfileKey({ providerId, connectionId, modelId }) {
  return JSON.stringify([providerId, connectionId, modelId]);
}

async function invalidate() {
  await deleteHotJson(`kv:${CAPABILITY_TEST_SCOPE}`).catch(() => {});
}

export async function getModelCapabilityTests(filter = {}) {
  const db = await getAdapter();
  return db.all("SELECT value FROM kv WHERE scope = ?", [CAPABILITY_TEST_SCOPE])
    .map((row) => parseJson(row.value, null))
    .filter((profile) => profile && ["providerId", "connectionId", "modelId"].every((field) => !filter[field] || profile[field] === filter[field]));
}

// The SQLite claim is shared by all workers. No network operation holds this transaction.
export async function claimModelCapabilityTest(identity, run, now = Date.now()) {
  const db = await getAdapter();
  const key = capabilityProfileKey(identity);
  let claimed = false;
  db.transaction(() => {
    const existing = parseJson(db.get("SELECT value FROM kv WHERE scope = ? AND key = ?", [CAPABILITY_TEST_SCOPE, key])?.value, {});
    if (existing.running?.expiresAt > now) return;
    const history = [...(existing.history || [])];
    if (existing.running) history.unshift({ ...existing.running.report, status: "interrupted", completedAt: new Date(now).toISOString() });
    const profile = {
      ...existing, ...identity,
      evidence: existing.fingerprint === run.fingerprint ? existing.evidence || {} : {},
      fingerprint: run.fingerprint,
      history: history.slice(0, CAPABILITY_HISTORY_LIMIT),
      running: { runId: run.runId, expiresAt: now + CAPABILITY_TEST_LIMITS.leaseMs, report: run },
    };
    db.run("INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value", [CAPABILITY_TEST_SCOPE, key, stringifyJson(profile)]);
    claimed = true;
  });
  db.flush?.();
  if (claimed) await invalidate();
  return claimed;
}

export async function saveModelCapabilityTest(identity, report, { final = false } = {}) {
  const db = await getAdapter();
  const key = capabilityProfileKey(identity);
  let saved = false;
  db.transaction(() => {
    const profile = parseJson(db.get("SELECT value FROM kv WHERE scope = ? AND key = ?", [CAPABILITY_TEST_SCOPE, key])?.value, null);
    if (!profile || profile.running?.runId !== report.runId) return;
    if (!final) {
      profile.running.report = report;
    } else {
      const evidence = { ...(profile.evidence || {}) };
      for (const [capability, result] of Object.entries(report.results || {})) {
        if (["supported", "unsupported"].includes(result.status)) {
          const previousContext = { ...(evidence[capability]?.context || {}) };
          const previousTestedAt = Date.parse(evidence[capability]?.testedAt || "");
          const sameContextLimit = capability !== "contextWindow" || !result.context?.explicitLimit
            || result.context.explicitLimit === previousContext.explicitLimit;
          const previousStillFresh = Number.isFinite(previousTestedAt)
            && Date.now() - previousTestedAt < CAPABILITY_EVIDENCE_TTL_MS;
          if (capability === "contextWindow" && !sameContextLimit && result.context?.explicitLimit < (previousContext.verifiedRetrievalTokens || 0)) {
            previousContext.verifiedRetrievalTokens = null;
            previousContext.acceptedInputTokens = null;
          }
          if (!previousStillFresh) {
            previousContext.verifiedRetrievalTokens = null;
            previousContext.acceptedInputTokens = null;
          }
          const context = result.context ? {
            ...previousContext, ...result.context,
            acceptedInputTokens: Math.max(previousContext.acceptedInputTokens || 0, result.context.acceptedInputTokens || 0) || null,
            verifiedRetrievalTokens: Math.max(previousContext.verifiedRetrievalTokens || 0, result.context.verifiedRetrievalTokens || 0) || null,
            verifiedTokenSource: (result.context.verifiedRetrievalTokens || 0) >= (previousContext.verifiedRetrievalTokens || 0)
              ? result.context.verifiedTokenSource || result.context.tokenSource
              : previousContext.verifiedTokenSource || previousContext.tokenSource,
          } : undefined;
          evidence[capability] = { ...result, ...(context ? { context } : {}), testedAt: report.completedAt, fingerprint: report.fingerprint, probeVersion: report.probeVersion };
        }
      }
      profile.evidence = evidence;
      profile.latest = report;
      profile.history = [report, ...(profile.history || [])].slice(0, CAPABILITY_HISTORY_LIMIT);
      delete profile.running;
    }
    db.run("UPDATE kv SET value = ? WHERE scope = ? AND key = ?", [stringifyJson(profile), CAPABILITY_TEST_SCOPE, key]);
    saved = true;
  });
  db.flush?.();
  if (saved) await invalidate();
  return saved;
}

export async function deleteModelCapabilityTests(filter) {
  if (!filter?.providerId && !filter?.connectionId) throw new Error("A channel or connection is required");
  const db = await getAdapter();
  let removed = 0;
  db.transaction(() => {
    for (const row of db.all("SELECT key, value FROM kv WHERE scope = ?", [CAPABILITY_TEST_SCOPE])) {
      const profile = parseJson(row.value, {});
      if (!["providerId", "connectionId", "modelId"].every((field) => !filter[field] || profile[field] === filter[field])) continue;
      if (profile.running?.expiresAt > Date.now()) throw new Error("能力测试正在运行，请先取消或等待完成");
      db.run("DELETE FROM kv WHERE scope = ? AND key = ?", [CAPABILITY_TEST_SCOPE, row.key]);
      removed++;
    }
  });
  db.flush?.();
  if (removed) await invalidate();
  return removed;
}
