import { randomUUID } from "node:crypto";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { getTargetFormat } from "open-sse/services/provider.js";
import { getModelUpstreamId, PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";
import { CAPABILITY_PROBE_VERSION, CAPABILITY_TESTS, QUICK_CAPABILITY_TESTS, CAPABILITY_TEST_LIMITS } from "@/shared/constants/capabilityTests.js";
import { claimModelCapabilityTest, saveModelCapabilityTest } from "@/lib/db/repos/modelCapabilityTestsRepo.js";
import { capabilityFingerprint } from "./evidence.js";
import { makeCapabilityProbe } from "./samples.js";
import { executeCapabilityProbe } from "./execute.js";
import { executeMediaProbe } from "./media.js";
import { classifyProbeFailure, validateProbeResponse, redactEvidence, responseText } from "./classify.js";

export function normalizeProbeOptions(input = {}) {
  const deep = input.mode === "deep";
  if (input.mode && !["quick", "deep"].includes(input.mode)) throw new Error("测试模式无效");
  const tests = deep ? ["contextWindow"] : input.tests || QUICK_CAPABILITY_TESTS;
  if (!Array.isArray(tests) || !tests.length || tests.length > CAPABILITY_TESTS.length || tests.some((key) => !CAPABILITY_TESTS.some((test) => test.key === key))) throw new Error("测试项目无效");
  const integer = (key, fallback, min, max) => {
    const value = input[key] ?? fallback;
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} 必须在 ${min}～${max} 之间`);
    return value;
  };
  return {
    mode: deep ? "deep" : "quick", tests: [...new Set(tests)],
    contextTokens: integer("contextTokens", deep ? CAPABILITY_TEST_LIMITS.deepContextTokens : CAPABILITY_TEST_LIMITS.quickContextTokens, 1024, CAPABILITY_TEST_LIMITS.maxContextTokens),
    maxRequests: integer("maxRequests", CAPABILITY_TEST_LIMITS.maxRequests, 1, CAPABILITY_TEST_LIMITS.hardMaxRequests),
    totalInputTokens: integer("totalInputTokens", CAPABILITY_TEST_LIMITS.totalInputTokens, 1024, CAPABILITY_TEST_LIMITS.hardTotalInputTokens),
    timeoutMs: integer("timeoutMs", CAPABILITY_TEST_LIMITS.timeoutMs, 5000, CAPABILITY_TEST_LIMITS.maxTimeoutMs),
  };
}

function tokenUsage(json, probe) {
  const usage = json?.usage;
  const input = usage?.prompt_tokens ?? usage?.input_tokens;
  const output = usage?.completion_tokens ?? usage?.output_tokens;
  return {
    inputTokens: Number.isFinite(input) && input > 0 ? input : probe.estimatedInputTokens || 4096,
    outputTokens: Number.isFinite(output) ? output : null,
    inputSource: Number.isFinite(input) && input > 0 ? "upstream" : "estimated",
  };
}

export async function runCapabilityTests(connection, modelId, options, { signal, emit, execute = executeCapabilityProbe, executeMedia = executeMediaProbe } = {}) {
  const identity = { providerId: connection.provider, connectionId: connection.id, modelId };
  const report = {
    ...identity, runId: randomUUID(), probeVersion: CAPABILITY_PROBE_VERSION,
    fingerprint: capabilityFingerprint(connection, modelId),
    upstreamModel: getModelUpstreamId(PROVIDER_ID_TO_ALIAS[connection.provider] || connection.provider, modelId),
    protocol: getTargetFormat(connection.provider, connection),
    startedAt: new Date().toISOString(), status: "running", options,
    declared: getCapabilitiesForModel(connection.provider, modelId, { declaredOnly: true }),
    results: Object.fromEntries(CAPABILITY_TESTS.map((test) => [test.key, { status: "untested", reason: "未选择此项目" }])),
    requests: 0, inputTokens: 0,
  };
  if (!await claimModelCapabilityTest(identity, report)) throw new Error("同一账号模型已有能力测试在运行");
  const started = Date.now();
  const secrets = [connection.apiKey, connection.accessToken, connection.refreshToken];
  const notify = (event) => { try { emit?.(event); } catch { /* A disconnected UI must not lose the stored report. */ } };
  const checkpoint = async (key, result) => {
    report.results[key] = result;
    await saveModelCapabilityTest(identity, report);
    notify({ type: "result", key, result, requests: report.requests, inputTokens: report.inputTokens });
  };
  const runProbe = async (key, targetTokens) => {
    signal.throwIfAborted();
    if (Date.now() - started > CAPABILITY_TEST_LIMITS.maxRunMs) throw new Error("达到整轮测试时间上限");
    if (report.requests >= options.maxRequests) return { status: "unknown", reason: "达到请求次数预算", stop: true };
    if (key === "search") return { status: "unknown", reason: "当前网关未提供可验证的原生搜索探测；不会把普通工具调用当成联网搜索" };
    if (["imageOutput", "audioOutput"].includes(key)) {
      report.requests++;
      try { return await executeMedia(identity, key, { signal, timeoutMs: options.timeoutMs }); }
      catch (error) { signal.throwIfAborted(); return { status: "unknown", reason: redactEvidence(error.message, secrets) }; }
    }
    const probe = await makeCapabilityProbe(key, { contextTokens: targetTokens });
    const estimate = probe.estimatedInputTokens || (["audioInput", "videoInput", "vision", "pdf"].includes(key) ? 4096 : Math.ceil(JSON.stringify(probe.body).length / 2));
    if (report.inputTokens + estimate + CAPABILITY_TEST_LIMITS.outputTokens > options.totalInputTokens) return { status: "unknown", reason: "达到累计 Token 预算（估算，不保证实际账单）", stop: true };
    report.requests++;
    notify({ type: "progress", key, request: report.requests, targetTokens: targetTokens || null });
    try {
      const result = await execute(identity, probe, { signal, timeoutMs: options.timeoutMs });
      const usage = tokenUsage(result.json, probe);
      report.inputTokens += usage.inputTokens;
      const status = result.status || result.response?.status || 200;
      const message = result.error || result.json?.error?.message || result.json?.error;
      let verdict = result.success && !message
        ? validateProbeResponse(key, result.json, probe.expected)
        : classifyProbeFailure(key, status, message, { upstream: result.dispatched && result.preserved && !!result.upstreamError });
      verdict = {
        ...verdict, httpStatus: status, latencyMs: result.latencyMs, usage,
        reason: redactEvidence(verdict.reason, secrets),
        evidence: redactEvidence(message || responseText(result.json), secrets),
        ...(!result.success && result.upstreamError && ([401, 402, 403, 404, 429].includes(status) || status >= 500) ? { stop: true } : {}),
      };
      if (key === "contextWindow") verdict.context = {
        ...(verdict.context || {}), targetTokens,
        acceptedInputTokens: result.success ? usage.inputTokens : null,
        verifiedRetrievalTokens: verdict.status === "supported" && !verdict.context?.rejected ? usage.inputTokens : null,
        tokenSource: usage.inputSource,
        verifiedTokenSource: verdict.status === "supported" && !verdict.context?.rejected ? usage.inputSource : null,
      };
      return verdict;
    } catch (error) {
      signal.throwIfAborted();
      report.inputTokens += estimate;
      return { status: "unknown", reason: redactEvidence(error.message, secrets), stop: true };
    }
  };
  notify({ type: "started", report });
  try {
    for (const key of options.tests) {
      signal.throwIfAborted();
      if (key !== "contextWindow" || options.mode !== "deep") {
        const result = await runProbe(key, options.contextTokens);
        await checkpoint(key, result);
        if (key === "text" && result.status !== "supported") break;
        if (result.stop) break;
        continue;
      }
      let target = Math.min(8192, options.contextTokens);
      let acceptedTarget = 0;
      let rejectedTarget = null;
      const steps = [];
      while (report.requests < options.maxRequests) {
        const result = await runProbe(key, target);
        steps.push(result);
        const previous = report.results[key]?.context || {};
        const context = {
          ...previous, ...result.context,
          acceptedInputTokens: Math.max(previous.acceptedInputTokens || 0, result.context?.acceptedInputTokens || 0) || null,
          verifiedRetrievalTokens: Math.max(previous.verifiedRetrievalTokens || 0, result.context?.verifiedRetrievalTokens || 0) || null,
          firstRejectedTarget: previous.firstRejectedTarget || (result.context?.rejected ? target : null),
          verifiedTokenSource: (result.context?.verifiedRetrievalTokens || 0) >= (previous.verifiedRetrievalTokens || 0)
            ? result.context?.verifiedTokenSource || result.context?.tokenSource
            : previous.verifiedTokenSource || previous.tokenSource,
        };
        await checkpoint(key, { ...result, context, steps: [...steps] });
        if (result.stop || result.status === "unknown" || result.status === "unsupported") break;
        if (result.context?.rejected) rejectedTarget = target;
        else acceptedTarget = target;
        if (context.explicitLimit) break;
        if (rejectedTarget !== null) {
          if (!acceptedTarget || rejectedTarget - acceptedTarget < 2048) break;
          target = Math.floor((acceptedTarget + rejectedTarget) / 2);
        } else {
          if (target >= options.contextTokens) break;
          // Usage is the calibration source; target remains an estimate for a
          // tokenizer we do not own. Both values stay visible in the report.
          const ratio = result.usage?.inputSource === "upstream" ? target / result.usage.inputTokens : 1;
          target = Math.min(options.contextTokens, Math.max(target + 1024, Math.floor(target * 2 * Math.min(1.5, Math.max(0.5, ratio)))));
        }
      }
    }
    report.status = "completed";
  } catch (error) {
    report.status = signal.aborted ? "cancelled" : "interrupted";
    report.error = redactEvidence(error.message || signal.reason, secrets);
  } finally {
    report.completedAt = new Date().toISOString();
    await saveModelCapabilityTest(identity, report, { final: true });
    notify({ type: "complete", report });
  }
  return report;
}
