// Ensure proxyFetch is loaded to patch globalThis.fetch
import "open-sse/index.js";

import { getProviderConnectionById } from "@/lib/localDb";
import { claimClaudeLimitReset, getClaudeLimitResetStatus, invalidateClaudeUsage } from "open-sse/services/usage.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "../route.js";

async function resolveConnection(params) {
  const { connectionId } = await params;
  const connection = await getProviderConnectionById(connectionId);
  if (!connection) return { response: Response.json({ error: "账号不存在" }, { status: 404 }) };
  if (connection.provider !== "claude" || connection.authType !== "oauth") {
    return { response: Response.json({ error: "仅 Claude OAuth 账号支持重置额度" }, { status: 400 }) };
  }
  const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData);
  const proxyOptions = {
    connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
    connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
    connectionNoProxy: proxyConfig.connectionNoProxy || "",
    strictProxy: false,
  };
  try {
    const refreshed = await refreshAndUpdateCredentials(connection, false, proxyOptions);
    return { connection: refreshed.connection, proxyOptions };
  } catch (error) {
    return { response: Response.json({ error: `Claude 授权刷新失败：${error.message}` }, { status: 401 }) };
  }
}

export async function GET(_request, { params }) {
  try {
    const resolved = await resolveConnection(params);
    if (resolved.response) return resolved.response;
    const status = await getClaudeLimitResetStatus(resolved.connection.accessToken, resolved.proxyOptions);
    return Response.json({ status });
  } catch (error) {
    return Response.json({ error: error.message || "读取 Claude 重置状态失败" }, { status: error.status === 401 ? 401 : 502 });
  }
}

export async function POST(request, { params }) {
  try {
    const body = await request.json().catch(() => ({}));
    const program = body?.program === "weekly" ? "weekly" : body?.program === "grant" ? "grant" : null;
    if (!program) return Response.json({ error: "program 必须为 grant 或 weekly" }, { status: 400 });
    const resolved = await resolveConnection(params);
    if (resolved.response) return resolved.response;
    const { connection, proxyOptions } = resolved;

    // Always claim against the server's current next grant, never a stale id.
    let grantId = null;
    if (program === "grant") {
      const status = await getClaudeLimitResetStatus(connection.accessToken, proxyOptions);
      grantId = status?.grants?.nextGrantId || null;
      if (!grantId) {
        return Response.json({ ok: false, result: "ineligible", message: "没有可用的重置卡" }, { status: 409 });
      }
    }
    // Server-generated id: the upstream dedupes on it, and a client cannot replay one.
    const requestId = crypto.randomUUID();
    const result = await claimClaudeLimitReset(connection.accessToken, { program, grantId, requestId, proxyOptions });
    if (result.ok) invalidateClaudeUsage(connection.accessToken);
    const status = result.ok ? 200
      : result.result === "auth_error" ? 401
        : result.result === "rate_limited" ? 429
          : result.result === "error" ? 502 : 409;
    return Response.json(result, { status });
  } catch (error) {
    return Response.json({ ok: false, result: "error", message: error.message || "重置请求失败" }, { status: 500 });
  }
}
