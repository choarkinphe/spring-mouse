import { NextResponse } from "next/server";
import {
  getProviderConnections,
  createProviderConnection,
  getAvailableMouseById,
  getProviderNodeById,
  getProviderNodes,
  getApiKeys,
} from "@/models";
import { PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import { buildModelsList } from "@/app/api/v1/models/route";
import { APIKEY_PROVIDERS } from "@/shared/constants/config";
import { AI_PROVIDERS, FREE_TIER_PROVIDERS, WEB_COOKIE_PROVIDERS, getProviderAlias, isOpenAICompatibleProvider, isAnthropicCompatibleProvider, isCustomEmbeddingProvider } from "@/shared/constants/providers";
import { normalizeProviderId, normalizeProviderSpecificData } from "@/lib/providerNormalization";
import { supportsMouseExecution } from "@/shared/constants/mouseSupport";
import { normalizeCustomChannelIconSrc } from "@/shared/constants/customChannelIcons";
import { getAdapter } from "@/lib/db/driver.js";

export const dynamic = "force-dynamic";

// Dashboard channel list enrichment: the newest usageHistory row per provider
// connection — its time, the API key (i.e. which operator/tool) behind it and
// the model it asked for.
//
// Kept inline in this route on purpose: Turbopack's dev server only recompiles
// the file it sees change, so a field added to a helper in usageRepo stays
// `undefined` here until the dev server restarts. Do not move it into the repo
// layer without also accepting that restart.
async function getConnectionLastRequests(connectionIds = []) {
  const ids = Array.from(new Set((connectionIds || []).filter((id) => typeof id === "string" && id)));
  if (ids.length === 0) return {};

  const db = await getAdapter();
  const result = {};
  // Keep the IN list small enough to stay under SQLite's variable limit.
  const CHUNK_SIZE = 400;
  for (let start = 0; start < ids.length; start += CHUNK_SIZE) {
    const chunk = ids.slice(start, start + CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    // MAX(id) rather than MAX(timestamp): ids are monotonic, so this always
    // resolves to exactly one row per connection instead of one per tied
    // timestamp.
    const rows = db.all(
      `SELECT connectionId, timestamp, apiKeyId, model
         FROM usageHistory
        WHERE id IN (SELECT MAX(id) FROM usageHistory WHERE connectionId IN (${placeholders}) GROUP BY connectionId)`,
      chunk,
    );
    for (const row of rows) {
      if (!row?.connectionId) continue;
      result[row.connectionId] = {
        at: row.timestamp || null,
        apiKeyId: row.apiKeyId || null,
        model: row.model || null,
      };
    }
  }
  return result;
}

async function getConnectionSuccessRates(connectionIds = [], windowMs = 20 * 60 * 1000) {
  const ids = Array.from(new Set((connectionIds || []).filter(Boolean)));
  if (ids.length === 0) return {};
  const db = getAdapter();
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  const result = {};
  const CHUNK_SIZE = 400;
  for (let start = 0; start < ids.length; start += CHUNK_SIZE) {
    const chunk = ids.slice(start, start + CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db.all(
      `SELECT connectionId,
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'error' OR status = 'cancelled' THEN 1 ELSE 0 END) AS failed
         FROM usageHistory
        WHERE connectionId IN (${placeholders}) AND timestamp >= ?
        GROUP BY connectionId`,
      [...chunk, cutoff],
    );
    for (const row of rows) {
      const total = Number(row.total) || 0;
      const failed = Number(row.failed) || 0;
      result[row.connectionId] = {
        total,
        success: Math.max(0, total - failed),
        rate: total > 0 ? Math.round(((total - failed) / total) * 100) : null,
      };
    }
  }
  return result;
}

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
      // Channel cards expose the LLM routing set. Counting every media kind here
      // made the card total larger than the model-management drawer and strategy
      // selector (for example, embedding/vision entries were included but are
      // managed under Media Services instead).
      const models = await buildModelsList(
        ["llm"],
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

    let successRateByConnection = {};
    try {
      successRateByConnection = await getConnectionSuccessRates(safeConnections.map((connection) => connection.id));
    } catch (error) {
      console.log("Error reading connection success rates:", error);
    }

    // Surface the newest request per account — when it ran and which API key
    // made it — so the channel list can show who is actually driving the
    // account, not just that it is busy.
    let lastRequestByConnection = {};
    try {
      lastRequestByConnection = await getConnectionLastRequests(safeConnections.map((connection) => connection.id));
    } catch (error) {
      console.log("Error reading last request times:", error);
    }

    // apiKeyId → display name. Only the name is handed to the client; the raw
    // key value never leaves the server.
    const apiKeyNames = new Map();
    try {
      for (const key of await getApiKeys()) {
        if (key?.id) apiKeyNames.set(key.id, key.name || null);
      }
    } catch (error) {
      console.log("Error reading API key names:", error);
    }

    const enrichedConnections = safeConnections.map((connection) => {
      const lastRequest = lastRequestByConnection[connection.id] || null;
      return {
        ...connection,
        lastRequestAt: lastRequest?.at || null,
        lastRequestBy: lastRequest?.apiKeyId ? apiKeyNames.get(lastRequest.apiKeyId) || null : null,
        lastRequestModel: lastRequest?.model || null,
        recentSuccessRate: successRateByConnection[connection.id] || { total: 0, success: 0, rate: null },
      };
    });

    return NextResponse.json({ connections: enrichedConnections, ...(includeModelCounts ? { modelCounts } : {}) });
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
    const { apiKey, name, displayName, priority, globalPriority, defaultModel, testStatus, mouseId } = body;
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
    let selectedMouse = null;
    if (mouseId) {
      // This provider's executor never reaches BaseExecutor.execute(), so the
      // Mouse dispatch branch would be skipped and traffic would silently stay
      // on the Spring host. Reject instead of storing a binding that lies.
      if (!supportsMouseExecution(provider)) {
        return NextResponse.json(
          { error: `Provider "${provider}" does not support Mouse execution` },
          { status: 400 },
        );
      }
      selectedMouse = await getAvailableMouseById(mouseId);
      if (!selectedMouse) {
        return NextResponse.json({ error: "Selected Mouse is not online" }, { status: 400 });
      }
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
      mouseId: selectedMouse?.id || null,
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
