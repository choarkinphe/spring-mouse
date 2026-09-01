import { NextResponse } from "next/server";
import {
  getProviderConnections,
  createProviderConnection,
  getProviderNodeById,
  getProviderNodes,
} from "@/models";
import { PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import { buildModelsList } from "@/app/api/v1/models/route";
import { APIKEY_PROVIDERS } from "@/shared/constants/config";
import { AI_PROVIDERS, FREE_TIER_PROVIDERS, WEB_COOKIE_PROVIDERS, getProviderAlias, isOpenAICompatibleProvider, isAnthropicCompatibleProvider, isCustomEmbeddingProvider } from "@/shared/constants/providers";
import { normalizeProviderId, normalizeProviderSpecificData } from "@/lib/providerNormalization";
import { normalizeCustomChannelIconSrc } from "@/shared/constants/customChannelIcons";

export const dynamic = "force-dynamic";

function normalizeProxyConfig(body = {}) {
  const enabled = body?.connectionProxyEnabled === true;
  const url = typeof body?.connectionProxyUrl === "string" ? body.connectionProxyUrl.trim() : "";
  const noProxy = typeof body?.connectionNoProxy === "string" ? body.connectionNoProxy.trim() : "";

  if (enabled && !url) {
    return { error: "Connection proxy URL is required when connection proxy is enabled" };
  }

  return {
    connectionProxyEnabled: enabled,
    connectionProxyUrl: url,
    connectionNoProxy: noProxy,
  };
}

// GET /api/providers - List all connections
export async function GET(request) {
  try {
    const connections = await getProviderConnections();
    const includeModelCounts = new URL(request.url).searchParams.get("includeModelCounts") === "1";

    // Build node metadata map for compatible providers (id → name and icon).
    let nodeMetadataMap = {};
    try {
      const nodes = await getProviderNodes();
      for (const node of nodes) {
        if (node.id) nodeMetadataMap[node.id] = { name: node.name, icon: normalizeCustomChannelIconSrc(node.icon) };
      }
    } catch { }

    // Hide sensitive fields, enrich name and icon for compatible providers.
    const safeConnections = connections.map(c => {
      const isCompatible = isOpenAICompatibleProvider(c.provider) || isAnthropicCompatibleProvider(c.provider);
      const node = nodeMetadataMap[c.provider];
      const name = isCompatible
        ? (c.name || node?.name || c.providerSpecificData?.nodeName || c.provider)
        : c.name;
      return {
        ...c,
        name,
        providerSpecificData: isCompatible
          ? {
              ...(c.providerSpecificData || {}),
              nodeName: node?.name || c.providerSpecificData?.nodeName || "",
              nodeIcon: node?.icon || c.providerSpecificData?.nodeIcon || "",
            }
          : c.providerSpecificData,
        apiKey: undefined,
        accessToken: undefined,
        refreshToken: undefined,
        idToken: undefined,
      };
    });

    let modelCounts;
    if (includeModelCounts) {
      // Use the same catalog construction as /v1/models, but never call live
      // provider catalogs while rendering the dashboard list.
      const models = await buildModelsList(
        ["llm", "embedding", "image", "imageToText", "video", "tts", "stt", "webSearch", "webFetch"],
        { skipDynamicFetch: true, includeProviderModels: true },
      );
      const aliasesByProvider = new Map();
      for (const connection of safeConnections) {
        const staticAlias = PROVIDER_ID_TO_ALIAS[connection.provider] || connection.provider;
        const outputAlias = (
          connection.providerSpecificData?.prefix
          || getProviderAlias(connection.provider)
          || staticAlias
        ).trim();
        const aliases = aliasesByProvider.get(connection.provider) || new Set();
        aliases.add(connection.provider);
        aliases.add(staticAlias);
        aliases.add(outputAlias);
        aliasesByProvider.set(connection.provider, aliases);
      }

      modelCounts = {};
      for (const [providerId, aliases] of aliasesByProvider.entries()) {
        modelCounts[providerId] = new Set(
          models
            .filter((model) => aliases.has(model.owned_by))
            .map((model) => model.id),
        ).size;
      }
    }

    return NextResponse.json({ connections: safeConnections, ...(includeModelCounts ? { modelCounts } : {}) });
  } catch (error) {
    console.log("Error fetching providers:", error);
    return NextResponse.json({ error: "Failed to fetch providers" }, { status: 500 });
  }
}

// POST /api/providers - Create new connection (API Key only, OAuth via separate flow)
export async function POST(request) {
  try {
    const body = await request.json();
    const provider = normalizeProviderId(body.provider);
    const { apiKey, name, displayName, priority, globalPriority, defaultModel, testStatus } = body;
    const proxyConfig = normalizeProxyConfig(body);
    if (proxyConfig.error) {
      return NextResponse.json({ error: proxyConfig.error }, { status: 400 });
    }

    // Validation
    const isWebCookieProvider = !!WEB_COOKIE_PROVIDERS[provider];
    // Dual-auth providers (e.g. codebuddy-cn, xai) live under category "oauth" but also
    // accept an API key via authModes — they aren't in APIKEY_PROVIDERS, so allow them here.
    const supportsApiKeyMode = !!AI_PROVIDERS[provider]?.authModes?.includes("apikey");
    const isValidProvider = APIKEY_PROVIDERS[provider] ||
      FREE_TIER_PROVIDERS[provider] ||
      supportsApiKeyMode ||
      isWebCookieProvider ||
      isOpenAICompatibleProvider(provider) ||
      isAnthropicCompatibleProvider(provider) ||
      isCustomEmbeddingProvider(provider);

    if (!provider || !isValidProvider) {
      return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
    }
    if (!apiKey && provider !== "ollama-local") {
      return NextResponse.json({ error: `${isWebCookieProvider ? "Cookie value" : "API Key"} is required` }, { status: 400 });
    }
    const connectionName = name || displayName || AI_PROVIDERS[provider]?.name;
    if (!connectionName) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    let providerSpecificData = normalizeProviderSpecificData(provider, body, body.providerSpecificData);

    // Compatible LLM nodes support multiple API-key connections (key pool); runtime
    // rotates/fails over via getProviderCredentials. Embedding nodes stay single-connection.
    if (isOpenAICompatibleProvider(provider)) {
      const node = await getProviderNodeById(provider);
      if (!node) {
        return NextResponse.json({ error: "OpenAI Compatible node not found" }, { status: 404 });
      }
      providerSpecificData = {
        prefix: node.prefix,
        apiType: node.apiType,
        baseUrl: node.baseUrl,
        nodeName: node.name,
        nodeIcon: normalizeCustomChannelIconSrc(node.icon),
      };
    } else if (isAnthropicCompatibleProvider(provider)) {
      const node = await getProviderNodeById(provider);
      if (!node) {
        return NextResponse.json({ error: "Anthropic Compatible node not found" }, { status: 404 });
      }
      providerSpecificData = {
        prefix: node.prefix,
        baseUrl: node.baseUrl,
        nodeName: node.name,
        nodeIcon: normalizeCustomChannelIconSrc(node.icon),
      };
    } else if (isCustomEmbeddingProvider(provider)) {
      const node = await getProviderNodeById(provider);
      if (!node) {
        return NextResponse.json({ error: "Custom Embedding node not found" }, { status: 404 });
      }
      providerSpecificData = {
        prefix: node.prefix,
        baseUrl: node.baseUrl,
        nodeName: node.name,
        nodeIcon: normalizeCustomChannelIconSrc(node.icon),
      };
    }

    const mergedProviderSpecificData = {
      ...(providerSpecificData || {}),
      connectionProxyEnabled: proxyConfig.connectionProxyEnabled,
      connectionProxyUrl: proxyConfig.connectionProxyUrl,
      connectionNoProxy: proxyConfig.connectionNoProxy,
    };
    delete mergedProviderSpecificData.proxyPoolId;

    const newConnection = await createProviderConnection({
      provider,
      authType: isWebCookieProvider ? "cookie" : "apikey",
      name: connectionName,
      apiKey: apiKey || "",
      priority: priority || 1,
      globalPriority: globalPriority || null,
      defaultModel: defaultModel || null,
      providerSpecificData: mergedProviderSpecificData,
      isActive: true,
      testStatus: testStatus || "unknown",
    });

    // Hide sensitive fields
    const result = { ...newConnection };
    delete result.apiKey;

    return NextResponse.json({ connection: result }, { status: 201 });
  } catch (error) {
    console.log("Error creating provider:", error);
    return NextResponse.json({ error: "Failed to create provider" }, { status: 500 });
  }
}
