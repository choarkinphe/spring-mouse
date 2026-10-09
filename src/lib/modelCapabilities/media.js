import { getImageAdapter } from "open-sse/handlers/imageProviders/index.js";
import { handleImageGenerationCore } from "open-sse/handlers/imageGenerationCore.js";
import { handleTtsCore } from "open-sse/handlers/ttsCore.js";
import { getProviderCredentials } from "@/sse/services/auth.js";
import { checkAndRefreshToken } from "@/sse/services/tokenRefresh.js";
import { withRouteLease } from "@/sse/services/routeLease.js";
import { runWithAbortDeadline } from "open-sse/utils/abortable.js";
import { readProbeResponse } from "./execute.js";
import { CAPABILITY_TEST_LIMITS } from "@/shared/constants/capabilityTests.js";

export function isValidProbeMedia(bytes, kind) {
  if (!bytes || bytes.length < 16) return false;
  if (kind === "imageOutput") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    || bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  return bytes.toString("ascii", 0, 3) === "ID3"
    || bytes[0] === 255 && (bytes[1] & 224) === 224
    || bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE"
    || bytes.toString("ascii", 0, 4) === "OggS";
}

export async function executeMediaProbe(identity, key, { signal, timeoutMs }) {
  const image = key === "imageOutput";
  const adapter = image ? getImageAdapter(identity.providerId) : null;
  // Executor/polling media adapters do not yet propagate cancellation. Do not
  // start potentially unbounded paid work through those paths.
  if (image && (!adapter || adapter.useExecutor || adapter.parseResponse)) return { status: "unknown", reason: "此渠道图片生成路径尚未提供可取消的固定账号探测" };
  if (!image && identity.providerId !== "openai") return { status: "unknown", reason: "此渠道语音路径尚未提供可取消的固定模型探测" };
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    return await runWithAbortDeadline(async () => {
      const credentials = await getProviderCredentials(identity.providerId, null, identity.modelId, { strictConnectionId: identity.connectionId, reserveSlot: true, signal: controller.signal });
      if (!credentials || credentials.pinnedUnavailable || credentials.allRateLimited) return { status: "unknown", reason: "指定账号当前不可用" };
      // These legacy media cores bypass the configured proxy/Mouse executor.
      if (credentials.mouseExecution || credentials.providerSpecificData?.connectionProxyEnabled) {
        await credentials.releaseRouteSlot?.();
        return { status: "unknown", reason: "该媒体接口尚不能保留此账号的代理/节点执行路径" };
      }
      const result = await withRouteLease(credentials.releaseRouteSlot, controller.signal, async () => {
        const refreshed = await checkAndRefreshToken(identity.providerId, credentials);
        return image
          ? handleImageGenerationCore({ body: { prompt: "A small solid blue square on a white background", n: 1, response_format: "b64_json" }, modelInfo: { provider: identity.providerId, model: identity.modelId }, credentials: refreshed, signal: controller.signal })
          : handleTtsCore({ provider: identity.providerId, model: `${identity.modelId}/alloy`, input: "Capability test.", credentials: refreshed, signal: controller.signal });
      });
      const bytes = await readProbeResponse(result.response, controller.signal, CAPABILITY_TEST_LIMITS.mediaResponseBytes);
      if (!result.success) return { status: "unknown", reason: result.error || "媒体生成未完成" };
      let media = bytes;
      if (image) {
        const json = JSON.parse(bytes.toString("utf8"));
        const base64 = json.data?.[0]?.b64_json;
        // Do not follow returned URLs (potential SSRF / credential leakage).
        if (!base64) return { status: "unknown", reason: "仅返回图片 URL，未取得可验证的媒体字节" };
        media = Buffer.from(base64, "base64");
      }
      return isValidProbeMedia(media, key)
        ? { status: "supported", reason: "固定账号/模型返回有效媒体字节", mediaBytes: media.length }
        : { status: "unknown", reason: "响应未包含可验证的媒体格式" };
    }, { signal: controller.signal, timeoutMs, onTimeout: () => controller.abort("probe_timeout") });
  } finally {
    signal.removeEventListener("abort", abort);
    controller.abort("probe_complete");
  }
}
