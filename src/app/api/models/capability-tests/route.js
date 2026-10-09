import { NextResponse } from "next/server";
import { getProviderConnectionById, getProviderConnections, getProviderNodes, getModelCapabilityTests, deleteModelCapabilityTests } from "@/lib/db/index.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import { refreshModelCapabilityOverrides } from "@/lib/modelCapabilityOverrides.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { capabilityFingerprint, currentEvidence } from "@/lib/modelCapabilities/evidence.js";
import { normalizeProbeOptions, runCapabilityTests } from "@/lib/modelCapabilities/runner.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

async function resolveChannel(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new Error("渠道标识无效");
  const resolved = resolveProviderId(value);
  const nodes = await getProviderNodes();
  return nodes.find((node) => node.prefix === value)?.id || resolved;
}
function modelIdentifier(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 255 || /[\x00-\x1f]/.test(value)) throw new Error("模型标识无效");
  return value.trim();
}
async function resolveConnection(providerId, connectionId) {
  if (connectionId === "noauth" && FREE_PROVIDERS[providerId]?.noAuth) return { id: "noauth", provider: providerId };
  if (typeof connectionId !== "string") throw new Error("请选择测试账号");
  const connection = await getProviderConnectionById(connectionId);
  if (!connection || connection.provider !== providerId) throw new Error("账号不属于指定渠道");
  if (connection.isActive === false) throw new Error("指定账号已停用");
  return connection;
}

export async function GET(request) {
  try {
    const search = new URL(request.url).searchParams;
    const providerId = await resolveChannel(search.get("providerId"));
    const modelId = search.get("modelId") ? modelIdentifier(search.get("modelId")) : undefined;
    const connections = await getProviderConnections({ provider: providerId });
    if (FREE_PROVIDERS[providerId]?.noAuth) connections.push({ id: "noauth", provider: providerId, name: "公共连接" });
    await refreshModelCapabilityOverrides({ force: true });
    const profiles = await getModelCapabilityTests({ providerId, modelId, connectionId: search.get("connectionId") || undefined });
    const reports = profiles.map((profile) => {
      const connection = connections.find((item) => item.id === profile.connectionId);
      const evidence = connection ? currentEvidence(profile, capabilityFingerprint(connection, profile.modelId)) : {};
      return {
        ...profile, currentEvidence: evidence, stale: Object.keys(evidence).length === 0,
        running: profile.running?.expiresAt > Date.now() ? profile.running : null,
        effective: getCapabilitiesForModel(providerId, profile.modelId, { connectionId: profile.connectionId }),
      };
    });
    return NextResponse.json({ providerId, profiles: reports, connections: connections.map((item) => ({ id: item.id, name: item.displayName || item.name || item.email || item.id, isActive: item.isActive !== false })), effective: modelId ? getCapabilitiesForModel(providerId, modelId) : null }, { headers });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400, headers });
  }
}

export async function POST(request) {
  try {
    const input = await request.json();
    const providerId = await resolveChannel(input.providerId);
    const modelId = modelIdentifier(input.modelId);
    const connection = await resolveConnection(providerId, input.connectionId);
    const options = normalizeProbeOptions(input);
    await refreshModelCapabilityOverrides({ force: true });
    const controller = new AbortController();
    const abort = () => controller.abort(request.signal.reason);
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(output) {
        const emit = (event) => {
          if (!controller.signal.aborted) output.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        };
        try {
          await runCapabilityTests(connection, modelId, options, { signal: controller.signal, emit });
          await refreshModelCapabilityOverrides({ force: true });
        } catch (error) {
          if (!controller.signal.aborted) emit({ type: "error", error: error.message });
        } finally {
          request.signal.removeEventListener("abort", abort);
          try { output.close(); } catch { /* Stream was cancelled. */ }
        }
      },
      cancel() { controller.abort("client_cancelled"); },
    });
    return new Response(stream, { headers: { ...headers, "Content-Type": "application/x-ndjson", "X-Accel-Buffering": "no" } });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400, headers });
  }
}

export async function DELETE(request) {
  try {
    const input = await request.json();
    const providerId = await resolveChannel(input.providerId);
    const modelId = modelIdentifier(input.modelId);
    await resolveConnection(providerId, input.connectionId);
    const removed = await deleteModelCapabilityTests({ providerId, modelId, connectionId: input.connectionId });
    await refreshModelCapabilityOverrides({ force: true });
    return NextResponse.json({ removed }, { headers });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400, headers });
  }
}
