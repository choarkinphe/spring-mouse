import { getProviderCredentials } from "@/sse/services/auth.js";
import { checkAndRefreshToken, updateProviderCredentials } from "@/sse/services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { withRouteLease } from "@/sse/services/routeLease.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { CAPABILITY_TEST_LIMITS } from "@/shared/constants/capabilityTests.js";
import { runWithAbortDeadline } from "open-sse/utils/abortable.js";
import { detectRequiredCapabilities } from "open-sse/services/combo.js";
import * as log from "@/sse/utils/logger.js";

export async function readProbeResponse(response, signal, maxBytes = CAPABILITY_TEST_LIMITS.responseBytes) {
  const reader = response?.body?.getReader();
  if (!reader) throw new Error("上游返回空响应");
  const chunks = [];
  let size = 0;
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("测试响应超出安全大小限制");
      chunks.push(Buffer.from(value));
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks);
  } finally {
    cancel();
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export async function executeCapabilityProbe(identity, probe, { signal, timeoutMs }) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  probe = { ...probe, originalBody: structuredClone(probe.body) };
  let dispatched = false;
  let preserved = true;
  const started = Date.now();
  try {
    return await runWithAbortDeadline(async () => {
      const credentials = await getProviderCredentials(identity.providerId, null, identity.modelId, {
        strictConnectionId: identity.connectionId, reserveSlot: true, body: probe.body, signal: controller.signal,
      });
      if (!credentials || credentials.pinnedUnavailable || credentials.allRateLimited) throw new Error(credentials?.error || "指定账号当前不可用");
      const result = await withRouteLease(credentials.releaseRouteSlot, controller.signal, async () => {
        const refreshed = await checkAndRefreshToken(identity.providerId, credentials);
        if (["antigravity", "gemini-cli"].includes(identity.providerId) && !refreshed.projectId) {
          const projectId = await getProjectIdForConnection(identity.connectionId, refreshed.accessToken, identity.providerId);
          if (projectId) { refreshed.projectId = projectId; await updateProviderCredentials(identity.connectionId, { projectId }); }
        }
        return handleChatCore({
          body: { ...probe.body, model: `${identity.providerId}/${identity.modelId}`, max_tokens: CAPABILITY_TEST_LIMITS.outputTokens },
          modelInfo: { provider: identity.providerId, model: identity.modelId },
          credentials: refreshed, connectionId: credentials.connectionId || "noauth",
          log, clientSignal: controller.signal, sourceFormatOverride: probe.sourceFormat,
          internalRequest: true, capabilityProbe: true, requestLogFileDumpsEnabled: false,
          onProbeDispatch: ({ body }) => {
            dispatched = true;
            const required = probe.body ? detectRequiredCapabilities(probe.originalBody || probe.body) : new Set();
            const actual = detectRequiredCapabilities(body);
            preserved = [...required].every((capability) => actual.has(capability));
            const serialized = JSON.stringify(body);
            if (probe.marker) preserved = preserved && serialized.includes(probe.marker);
            if (probe.body.tools?.length) preserved = preserved && serialized.includes("capability_echo");
            if (probe.body.response_format) preserved = preserved && /json_schema|responseSchema/.test(serialized);
            if (probe.body.reasoning_effort) preserved = preserved && /reasoning|thinking/.test(serialized);
            if (!preserved) throw new Error("网关协议转换未能保留测试输入，不能判定上游模型能力");
          },
          onCredentialsRefreshed: (newCredentials) => updateProviderCredentials(identity.connectionId, {
            ...newCredentials, existingProviderSpecificData: credentials.providerSpecificData,
          }),
        });
      });
      if (!result.success && !result.response) return { ...result, json: null, dispatched, preserved, latencyMs: Date.now() - started };
      const raw = await readProbeResponse(result.response, controller.signal);
      let json;
      try { json = JSON.parse(raw.toString("utf8")); } catch { throw new Error("测试未获得完整 JSON 响应，不能判定能力"); }
      return { ...result, json, dispatched, preserved, latencyMs: Date.now() - started };
    }, { signal: controller.signal, timeoutMs, onTimeout: () => controller.abort("probe_timeout") });
  } finally {
    signal.removeEventListener("abort", abort);
    controller.abort("probe_complete");
  }
}
