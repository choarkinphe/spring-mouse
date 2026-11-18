import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";
import { GEMINI_CONFIG } from "@/lib/oauth/constants/oauth";
import { refreshGoogleToken, refreshCodexToken, refreshClaudeOAuthToken, updateProviderCredentials } from "@/sse/services/tokenRefresh";
import { resolveOllamaLocalHost } from "open-sse/config/providers.js";
import { getModelsByProviderId } from "open-sse/config/providerModels.js";
import { resolveKiroModels } from "open-sse/services/kiroModels.js";
import { resolveKimchiModels } from "open-sse/services/kimchiModels.js";
import { resolveQoderModels } from "open-sse/services/qoderModels.js";
import { withQoderProviderRegion } from "open-sse/shared/qoder/constants.js";
import { resolveGrokCliModels } from "open-sse/services/grokCliModels.js";
import { resolveDevinModels } from "open-sse/services/devinModels.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { resolveCursorModels } from "open-sse/services/cursorModels.js";
import { QIANWEN_ENDPOINTS } from "open-sse/config/qianwen.js";
import { JEVAPI_CONFIG, parseJevapiModels } from "open-sse/config/jevapi.js";
import { discoverWorkBuddyModels } from "open-sse/services/workbuddyModels.js";
import { OFFICIAL_MODEL_CATALOG } from "@/shared/config/officialModelCatalog";
import { officialDiscovery, parseOfficialModelPayload, validateOfficialModels } from "@/shared/utils/officialModelDiscovery";
import { parseOfficialCatalogModels, parseFalModelPage } from "@/shared/utils/officialModelCatalogShapes";

const GEMINI_CLI_MODELS_URL = "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";

// `/codex/models` gates every entry against the caller's `client_version`: an entry
// whose own `minimal_client_version` is higher is simply left out of an otherwise
// perfectly valid 200 response. A hardcoded version therefore rots silently — this
// file asked for 0.163.0 while gpt-6.2-sol and gpt-6.2-astra demanded 0.166.0, so
// both models were invisible to "sync models" and could only be added by hand. No
// error, no warning, no truncated flag: just a shorter list.
//
// There is no endpoint that reports the current client version, but the catalog is
// its own oracle: ask with a deliberately impossible version and every entry comes
// back carrying the version it requires. The highest of those IS the version to
// send, so the next model release raises the answer by itself.
const CODEX_MODELS_ENDPOINT = "https://chatgpt.com/backend-api/codex/models";
const CODEX_PROBE_CLIENT_VERSION = "999.0.0";
// Used only when the probe cannot run at all (offline, upstream error). A stale
// value degrades to the old behaviour — newest models missing — never to a failure.
const CODEX_FALLBACK_CLIENT_VERSION = "0.166.0";

const parseClientVersion = (value) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? "").trim());
  return match ? match.slice(1).map(Number) : null;
};

const compareClientVersions = (a, b) => {
  const left = parseClientVersion(a);
  const right = parseClientVersion(b);
  if (!left || !right) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
};

/** Highest `minimal_client_version` the catalog reports, i.e. the version that unlocks all of it. */
const highestRequiredClientVersion = (models) => {
  let highest = null;
  for (const model of Array.isArray(models) ? models : []) {
    const declared = model?.minimal_client_version;
    if (!parseClientVersion(declared)) continue;
    if (!highest || compareClientVersions(declared, highest) > 0) highest = declared.trim();
  }
  return highest;
};

/**
 * One catalog request at an explicit client_version. Returns the raw entries so the
 * probe can read `minimal_client_version`; the caller parses them into model records.
 */
const requestCodexDirectory = async (token, clientVersion) => {
  const url = `${CODEX_MODELS_ENDPOINT}?client_version=${encodeURIComponent(clientVersion)}`;
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${token}`,
        "originator": "codex_cli_rs"
      },
      cache: "no-store",
      signal: AbortSignal.timeout(15000)
    });
  } catch {
    return { ok: false, status: 502 };
  }
  if (!response.ok) return { ok: false, status: response.status };
  let data;
  try { data = await response.json(); } catch { return { ok: false, status: 502 }; }
  // Same incompleteness contract buildOAuthResolver enforces for every OAuth
  // directory: a soft-paged or flagged answer is not a whole listing, and treating
  // it as one would store a truncated catalog as if it were complete.
  if (data?.error || data?.warning || data?.success === false || data?.has_more === true
    || data?.next_page_token || data?.nextPageToken
    || (data?.code !== undefined && ![0, 200, "0", "200"].includes(data.code))) {
    return { ok: false, status: 502, invalid: true };
  }
  // Same envelope shapes parseOfficialModelPayload accepts, so a directory that
  // answers `{data: [...]}` keeps working exactly as it did before.
  const models = Array.isArray(data) ? data : data?.models ?? data?.data ?? data?.results;
  if (!Array.isArray(models)) return { ok: false, status: 502, invalid: true };
  return { ok: true, status: response.status, models };
};

// buildOAuthResolver drives the refresh-on-401 path off a Response, so hand it one.
const codexDirectoryResponse = (models) => new Response(JSON.stringify({ models }), {
  status: 200,
  headers: { "Content-Type": "application/json" },
});

/**
 * Discover the Codex directory at the version the catalog itself asks for.
 *
 * A probe at an impossible version returns every entry with its own
 * `minimal_client_version`; the highest of those is what a full listing needs, so
 * the version is read from upstream instead of being maintained here. The probe is
 * then confirmed by re-asking at that exact version — a request never claims a
 * client build that does not exist, and the gate stays whatever upstream says it is.
 *
 * Failures degrade to a shorter list rather than an error: 401/403 stay a Response
 * so the caller's refresh path still sees them, everything else retries once at the
 * last known-good version.
 */
const resolveCodexDirectory = async (token) => {
  const probe = await requestCodexDirectory(token, CODEX_PROBE_CLIENT_VERSION);
  if (!probe.ok) {
    // An auth failure belongs to the caller's refresh path, not to the fallback.
    if (probe.status === 401 || probe.status === 403) {
      return new Response(JSON.stringify({ error: "Failed to fetch Codex models" }), { status: probe.status });
    }
    // A well-formed-but-incomplete body will not improve at another version, so
    // report it instead of retrying into the same answer.
    if (probe.invalid) {
      return new Response(JSON.stringify({ error: "Upstream returned an invalid or incomplete model list" }), { status: 502 });
    }
    const fallback = await requestCodexDirectory(token, CODEX_FALLBACK_CLIENT_VERSION);
    if (fallback.ok) return codexDirectoryResponse(fallback.models);
    return new Response(JSON.stringify({ error: "Failed to fetch Codex models" }), { status: probe.status || fallback.status || 502 });
  }

  const required = highestRequiredClientVersion(probe.models);
  if (!required || compareClientVersions(required, CODEX_PROBE_CLIENT_VERSION) >= 0) {
    return codexDirectoryResponse(probe.models);
  }
  // Prefer the confirmation, but never lose an entry the probe already exposed: the
  // probe's superset is exactly what this account is entitled to call.
  const confirmed = await requestCodexDirectory(token, required);
  if (confirmed.ok && confirmed.models.length >= probe.models.length) {
    return codexDirectoryResponse(confirmed.models);
  }
  return codexDirectoryResponse(probe.models);
};

const parseOpenAIStyleModels = (data) => parseOfficialModelPayload(data);

const parseGeminiCliModels = (data) => {
  if (Array.isArray(data?.models)) {
    return parseOfficialModelPayload(data, "gemini");
  }

  if (data?.models && typeof data.models === "object") {
    return Object.entries(data.models)
      .filter(([, info]) => !info?.isInternal)
      .map(([id, info]) => ({
        id,
        name: info?.displayName || info?.name || id,
      }));
  }

  throw new Error("Upstream returned an invalid model list");
};

const parseCodexModels = (data) => parseOpenAIStyleModels(data);

const createOpenAIModelsConfig = (url) => ({
  url,
  method: "GET",
  headers: { "Content-Type": "application/json" },
  authHeader: "Authorization",
  authPrefix: "Bearer ",
  parseResponse: parseOpenAIStyleModels
});

const getStaticProviderModels = (providerId) =>
  getModelsByProviderId(providerId).map((model) => ({
    ...model,
    id: model.id,
    name: model.name || model.id,
  }));

// Generic custom resolver for OAuth providers that need refresh-on-401 + token persist.
// Receives a `fetchFn(token)` and returns parsed models or throws.
const buildOAuthResolver = ({ refreshFn, fetchFn, parseFn, errorLabel }) => async (connection) => {
  const { accessToken, refreshToken } = connection;
  if (!accessToken) {
    return { error: "No valid token found", status: 401 };
  }
  try {
    let response = await fetchFn(accessToken, connection);
    if (!response.ok && (response.status === 401 || response.status === 403) && refreshToken) {
      const refreshed = await refreshFn(connection);
      if (refreshed?.accessToken) {
        await updateProviderCredentials(connection.id, {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken || refreshToken,
          expiresIn: refreshed.expiresIn,
        });
        connection.accessToken = refreshed.accessToken;
        if (refreshed.refreshToken) connection.refreshToken = refreshed.refreshToken;
        response = await fetchFn(refreshed.accessToken, connection);
      } else if (refreshed?.lastRefreshFailureAt) {
        // This path calls the bare refresh function (not refreshProviderCredentials),
        // so it never reached mergeRefreshedCredentials. A dead refresh token was
        // therefore retried every time the dashboard loaded the channel page,
        // with no marker written and no cooldown — the same retry storm the
        // cooldown exists to stop, arriving through a different door.
        await updateProviderCredentials(connection.id, {
          lastRefreshFailureAt: refreshed.lastRefreshFailureAt,
          lastRefreshFailureCode: refreshed.lastRefreshFailureCode ?? null,
        });
      }
    }
    if (response.ok) {
      const data = await response.json();
      if (data?.error || data?.warning || data?.success === false || data?.has_more === true || data?.next_page_token || data?.nextPageToken) {
        return { error: "Upstream returned an invalid or incomplete model list", status: 502 };
      }
      const models = parseFn(data);
      return { models: validateOfficialModels(models) };
    }
    return { error: `${errorLabel}: ${response.status}`, status: response.status };
  } catch {
    return { error: `${errorLabel}: invalid or unavailable official directory`, status: 502 };
  }
};

// Provider models endpoints configuration
const PROVIDER_MODELS_CONFIG = {
  workbuddy: { customResolver: async connection => discoverWorkBuddyModels(connection, await resolveConnectionProxyConfig(connection.providerSpecificData)) },
  "workbuddy-ai": { customResolver: async connection => discoverWorkBuddyModels(connection, await resolveConnectionProxyConfig(connection.providerSpecificData)) },
  claude: {
    url: "https://api.anthropic.com/v1/models",
    method: "GET",
    headers: {
      "Anthropic-Version": "2023-06-01",
      "Content-Type": "application/json"
    },
    authHeader: "x-api-key",
    parseResponse: (data) => parseOfficialModelPayload({ ...data, data: data?.data })
  },
  gemini: {
    url: "https://generativelanguage.googleapis.com/v1beta/models",
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authQuery: "key", // Use query param for API key
    parseResponse: (data) => parseOfficialModelPayload(data, "gemini")
  },
  codex: {
    customResolver: buildOAuthResolver({
      refreshFn: (conn) => refreshCodexToken(conn.refreshToken),
      fetchFn: (token) => resolveCodexDirectory(token),
      parseFn: parseCodexModels,
      errorLabel: "Failed to fetch Codex models"
    })
  },
  antigravity: {
    url: "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:models",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    body: {},
    parseResponse: (data) => {
      if (!Array.isArray(data?.models)) throw new Error("Upstream returned an invalid model list");
      return parseOfficialModelPayload(data);
    }
  },
  github: {
    url: "https://api.githubcopilot.com/models",
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Copilot-Integration-Id": "vscode-chat",
      "editor-version": "vscode/1.107.1",
      "editor-plugin-version": "copilot-chat/0.26.7",
      "user-agent": "GitHubCopilotChat/0.26.7"
    },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: (data) => {
      const rawModels = parseOfficialModelPayload(data);
      // Filter out embeddings, non-chat models, and disabled models
      return rawModels
        .filter(m => m.capabilities?.type === "chat")
        .filter(m => m.policy?.state !== "disabled") // Only return explicitly enabled models
        .map(m => ({
          id: m.id,
          name: m.name || m.id,
          version: m.version,
          capabilities: m.capabilities,
          isDefault: m.model_picker_enabled === true
        }));
    }
  },
  qianwen: createOpenAIModelsConfig(QIANWEN_ENDPOINTS.qianwen.models),
  "qianwen-token-plan": createOpenAIModelsConfig(QIANWEN_ENDPOINTS["qianwen-token-plan"].models),
  openai: createOpenAIModelsConfig("https://api.openai.com/v1/models"),
  openrouter: createOpenAIModelsConfig("https://openrouter.ai/api/v1/models"),
  "opencode-go": {
    // Official public directory, not an account entitlement check. Do not send
    // stored credentials to this unauthenticated discovery endpoint.
    customResolver: async () => {
      const response = await fetch("https://opencode.ai/inference/go/v1/models", {
        method: "GET",
        headers: { "Accept": "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        return { error: `Failed to fetch models: ${response.status}`, status: response.status };
      }
      let data;
      try {
        data = await response.json();
      } catch {
        return { error: "Upstream returned an invalid model list", status: 502 };
      }
      if (data?.error || data?.warning || data?.success === false || (data?.code !== undefined && ![0, 200, "0", "200"].includes(data.code)) || data?.has_more === true || data?.next_page_token || data?.nextPageToken || !Array.isArray(data?.data) || data.data.some((model) =>
        typeof model?.id !== "string" || !model.id.trim())) {
        return { error: "Upstream returned an invalid model list", status: 502 };
      }
      const known = new Map(getStaticProviderModels("opencode-go").map((model) => [model.id, model]));
      return {
        listingScope: "public",
        models: data.data.map((model) => ({
          ...model,
          name: model.name || known.get(model.id)?.name || model.id,
          ...(known.get(model.id)?.supportedFormats
            ? { supportedFormats: known.get(model.id).supportedFormats } : {}),
        })),
      };
    },
  },
  anthropic: {
    url: "https://api.anthropic.com/v1/models",
    method: "GET",
    headers: {
      "Anthropic-Version": "2023-06-01",
      "Content-Type": "application/json"
    },
    authHeader: "x-api-key",
    parseResponse: (data) => parseOfficialModelPayload({ ...data, data: data?.data })
  },

  alicode: {
    url: "https://coding.dashscope.aliyuncs.com/v1/models",
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: (data) => parseOfficialModelPayload({ ...data, data: data?.data })
  },
  "alicode-intl": {
    url: "https://coding-intl.dashscope.aliyuncs.com/v1/models",
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: (data) => parseOfficialModelPayload({ ...data, data: data?.data })
  },
  "alims-intl": {
    url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: (data) => parseOfficialModelPayload({ ...data, data: data?.data })
  },
  "volcengine-ark": createOpenAIModelsConfig("https://ark.cn-beijing.volces.com/api/coding/v3/models"),
  byteplus: createOpenAIModelsConfig("https://ark.ap-southeast.bytepluses.com/api/coding/v3/models"),

  // OpenAI-compatible API key providers
  deepseek: createOpenAIModelsConfig("https://api.deepseek.com/models"),
  groq: createOpenAIModelsConfig("https://api.groq.com/openai/v1/models"),
  xai: createOpenAIModelsConfig("https://api.x.ai/v1/models"),
  mistral: createOpenAIModelsConfig("https://api.mistral.ai/v1/models"),
  perplexity: createOpenAIModelsConfig("https://api.perplexity.ai/v1/models"),
  "perplexity-agent": createOpenAIModelsConfig("https://api.perplexity.ai/v1/models"),
  together: createOpenAIModelsConfig("https://api.together.xyz/v1/models"),
  fireworks: createOpenAIModelsConfig("https://api.fireworks.ai/inference/v1/models"),
  cerebras: createOpenAIModelsConfig("https://api.cerebras.ai/v1/models"),
  cohere: { ...createOpenAIModelsConfig("https://api.cohere.ai/v1/models"), parseResponse: (data) => parseOfficialModelPayload(data, "cohere") },
  nebius: createOpenAIModelsConfig("https://api.studio.nebius.ai/v1/models"),
  siliconflow: createOpenAIModelsConfig("https://api.siliconflow.com/v1/models"),
  "glm-cn": createOpenAIModelsConfig("https://open.bigmodel.cn/api/coding/paas/v4/models"),
  hyperbolic: createOpenAIModelsConfig("https://api.hyperbolic.xyz/v1/models"),
  ollama: { ...createOpenAIModelsConfig("https://ollama.com/api/tags"), parseResponse: (data) => parseOfficialModelPayload(data, "ollama") },
  // ollama-local: url resolved dynamically below via providerSpecificData.baseUrl
  nanobanana: createOpenAIModelsConfig("https://api.nanobananaapi.ai/v1/models"),
  // JevAPI / TypeSafe System One — native {models:[{name,description,release_date}]};
  // parsed to type "systemone" so a synced model is never treated as chat.
  jevapi: {
    url: JEVAPI_CONFIG.modelsUrl,
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: (data) => {
      parseOfficialModelPayload(data, "cohere"); // JevAPI uses model.name as its official ID.
      return validateOfficialModels(parseJevapiModels(data));
    },
  },
  chutes: createOpenAIModelsConfig("https://llm.chutes.ai/v1/models"),
  nvidia: createOpenAIModelsConfig("https://integrate.api.nvidia.com/v1/models"),
  assemblyai: createOpenAIModelsConfig("https://api.assemblyai.com/v1/models"),
  "vercel-ai-gateway": createOpenAIModelsConfig("https://ai-gateway.vercel.sh/v1/models"),
  // Key-group-scoped directory — what THIS key can call, not a public catalog.
  corecode: createOpenAIModelsConfig("https://corecode.live/v1/models"),
  kimchi: {
    customResolver: async (connection) => {
      const result = await resolveKimchiModels({
        accessToken: connection.accessToken,
        apiKey: connection.apiKey,
        providerSpecificData: connection.providerSpecificData || {},
      }, { forceRefresh: true, log: console });
      if (result?.models?.length) {
        return { models: result.models };
      }
      return { error: "Kimchi official model discovery failed", status: 502 };
    }
  },
  cursor: {
    customResolver: async (connection) => {
      const result = await resolveCursorModels({
        accessToken: connection.accessToken,
        providerSpecificData: connection.providerSpecificData || {},
      }, { forceRefresh: true, log: console });
      if (result?.models?.length) return { models: result.models };
      return { error: "Cursor official model discovery failed", status: 502 };
    },
  },

  // Custom resolvers (non-OpenAI-shaped APIs / token-refresh flows)
  kiro: {
    customResolver: async (connection) => {
      const credentials = {
        accessToken: connection.accessToken,
        refreshToken: connection.refreshToken,
        providerSpecificData: connection.providerSpecificData || {}
      };
      let warning;
      try {
        const result = await resolveKiroModels(credentials, {
          log: console,
          forceRefresh: true,
          onCredentialsRefreshed: async (refreshed) => {
            if (refreshed?.accessToken) {
              await updateProviderCredentials(connection.id, {
                accessToken: refreshed.accessToken,
                refreshToken: refreshed.refreshToken || connection.refreshToken,
                expiresIn: refreshed.expiresIn,
              });
              connection.accessToken = refreshed.accessToken;
              if (refreshed.refreshToken) connection.refreshToken = refreshed.refreshToken;
            }
          }
        });
        if (result?.models?.length) {
          return {
            // Kiro's service expands runtime thinking/agentic aliases. Those
            // remain executable, but are not official directory IDs.
            models: result.models.filter((m) => m.id === m.upstreamModelId).map((m) => ({
              id: m.id,
              name: m.name,
              upstreamModelId: m.upstreamModelId,
              contextLength: m.contextLength,
              rateMultiplier: m.rateMultiplier,
              capabilities: m.capabilities,
              description: m.description
            }))
          };
        }
        warning = "Kiro official directory was unavailable or invalid.";
      } catch (error) {
        warning = `Failed to fetch Kiro models: ${error.message}`;
        console.log("Failed to fetch Kiro official models:", error.message);
      }
      return { error: warning || "Official model discovery failed", status: 502 };
    }
  },
  qoder: {
    customResolver: async (connection) => {
      const credentials = {
        accessToken: connection.accessToken,
        apiKey: connection.apiKey,
        refreshToken: connection.refreshToken,
        email: connection.email,
        displayName: connection.displayName,
        providerSpecificData: connection.providerSpecificData,
      };
      let warning;
      try {
        credentials.providerSpecificData = withQoderProviderRegion("qoder", credentials.providerSpecificData);
        const result = await resolveQoderModels(credentials, { forceRefresh: true });
        if (result?.models?.length) {
          return {
            models: result.models.map((m) => ({
              // Store the native key; the provider alias is applied by the
              // model picker, not baked into the upstream directory ID.
              id: m.id,
              name: m.name,
              rateMultiplier: m.rateMultiplier,
              originalRateMultiplier: m.originalRateMultiplier,
              isFree: m.isFree,
              contextLength: m.contextLength,
              isVL: m.isVL,
              isReasoning: m.isReasoning,
              maxOutputTokens: m.maxOutputTokens,
              description: m.description,
            })),
          };
        }
        warning = "Qoder official directory was unavailable or invalid.";
      } catch (error) {
        warning = `Failed to fetch Qoder models: ${error.message}`;
        console.log("Failed to fetch Qoder official models:", error.message);
      }
      return { error: warning || "Official model discovery failed", status: 502 };
    },
  },
  "qoder-cn": {
    customResolver: async (connection) => {
      try {
        const result = await resolveQoderModels({
          accessToken: connection.accessToken,
          apiKey: connection.apiKey,
          refreshToken: connection.refreshToken,
          email: connection.email,
          displayName: connection.displayName,
          providerSpecificData: withQoderProviderRegion("qoder-cn", connection.providerSpecificData),
        }, { forceRefresh: true });
        if (result?.models?.length) return { models: result.models.map((m) => ({
          id: m.id, name: m.name, rateMultiplier: m.rateMultiplier,
          originalRateMultiplier: m.originalRateMultiplier, isFree: m.isFree,
          contextLength: m.contextLength, isVL: m.isVL,
          isReasoning: m.isReasoning, maxOutputTokens: m.maxOutputTokens, description: m.description,
        })) };
        return { error: "Qoder CN official directory was unavailable or invalid.", status: 502 };
      } catch (error) {
        return { error: `Failed to fetch Qoder CN models: ${error.message}`, status: 502 };
      }
    },
  },
  "gemini-cli": {
    customResolver: buildOAuthResolver({
      refreshFn: (conn) => refreshGoogleToken(conn.refreshToken, GEMINI_CONFIG.clientId, GEMINI_CONFIG.clientSecret),
      fetchFn: (token, conn) => {
        const projectId = conn.projectId || conn.providerSpecificData?.projectId;
        const body = projectId ? { project: projectId } : {};
        return fetch(GEMINI_CLI_MODELS_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
            "User-Agent": "google-api-nodejs-client/9.15.1",
            "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1"
          },
          body: JSON.stringify(body)
        });
      },
      parseFn: parseGeminiCliModels,
      errorLabel: "Failed to fetch Gemini CLI models"
    })
  },
  devin: {
    customResolver: async (connection) => {
      const proxyOptions = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
      return resolveDevinModels(connection, { proxyOptions });
    },
  },
  "grok-cli": {
    customResolver: async (connection) => {
      const proxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
      const result = await resolveGrokCliModels({
        ...connection,
        connectionId: connection.id,
      }, {
        log: console,
        proxyOptions: {
          connectionProxyEnabled: proxy.connectionProxyEnabled === true,
          connectionProxyUrl: proxy.connectionProxyUrl || "",
          connectionNoProxy: proxy.connectionNoProxy || "",
          strictProxy: proxy.strictProxy === true,
        },
        onCredentialsRefreshed: async (refreshed) => {
          await updateProviderCredentials(connection.id, {
            ...refreshed,
            existingProviderSpecificData: connection.providerSpecificData || {},
          });
        },
      });
      if (result.models.length) return result;
      return { error: "Grok CLI official model discovery failed", status: 502 };
    },
  },
  "ollama-local": {
    customResolver: async (connection) => {
      const url = `${resolveOllamaLocalHost(connection)}/api/tags`;
      const response = await fetch(url, {
        method: "GET",
        headers: { "Content-Type": "application/json" }
      });
      if (!response.ok) {
        const errorText = await response.text();
        console.log("Error fetching models from ollama-local:", errorText);
        return { error: `Failed to fetch models: ${response.status}`, status: response.status };
      }
      const data = await response.json();
      return { models: parseOfficialModelPayload(data, "ollama") };
    }
  }
};

function catalogConfig(providerId) {
  const entry = OFFICIAL_MODEL_CATALOG[providerId];
  if (!entry) return null;
  const auth = entry.auth || "bearer";
  return {
    ...entry,
    method: entry.method || "GET",
    listingScope: entry.scope || "account",
    headers: { Accept: "application/json", ...entry.headers },
    authHeader: ["x-api-key", "xi-api-key"].includes(auth) ? auth : ["bearer", "token"].includes(auth) ? "Authorization" : undefined,
    authPrefix: auth === "bearer" ? "Bearer " : auth === "token" ? "Token " : "",
    authQuery: auth === "query-key" ? "key" : undefined,
    parseResponse: (data) => {
      const models = parseOfficialCatalogModels(data, entry.shape || "openai");
      return entry.filter === "opencode-free" ? models.filter((model) => model.id.endsWith("-free") || model.id === "big-pickle") : models;
    },
  };
}

async function modelDiscoveryHttpError(response, provider) {
  const status = response.status;
  // Only expose a known, actionable error. Raw upstream diagnostics can contain
  // credentials or HTML, so unknown responses keep the status-only fallback.
  if (provider === "xai" && (status === 402 || status === 403)) {
    try {
      const data = await response.json();
      if (data?.code === "personal-team-blocked:spending-limit") {
        return {
          error: `同步模型失败（HTTP ${status}）：Grok 额度不足或需要有效订阅。请前往 https://grok.com/?_s=usage 检查用量、充值或升级订阅。`,
          status,
        };
      }
    } catch { /* Keep the safe fallback for non-JSON upstream responses. */ }
  }
  return { error: `Failed to fetch models: ${status}`, status };
}

// Called by both GET and synchronization, so the write path never trusts a
// client-supplied "officialFetched" flag or a hand-constructed model array.
export async function discoverConnectionModels(connection) {
  const provider = connection.provider;
  let config = catalogConfig(provider) || PROVIDER_MODELS_CONFIG[provider];
  if (isOpenAICompatibleProvider(provider) || isAnthropicCompatibleProvider(provider)) {
    let baseUrl = connection.providerSpecificData?.baseUrl?.replace(/\/$/, "");
    if (!baseUrl) return { error: "No base URL configured", status: 400 };
    if (isAnthropicCompatibleProvider(provider) && baseUrl.endsWith("/messages")) baseUrl = baseUrl.slice(0, -9);
    config = createOpenAIModelsConfig(`${baseUrl}/models`);
    if (isAnthropicCompatibleProvider(provider)) {
      config.headers = { ...config.headers, "anthropic-version": "2023-06-01" };
      config.authHeader = "x-api-key";
      config.authPrefix = "";
    }
  }
  if (!config) return { error: `Provider ${provider} has no implemented official model listing`, status: 501, unsupported: true };
  // Legacy connections may lack authType. Explicit API Key connections must
  // never pick up a stale OAuth token (or a Copilot token) from another flow.
  const claudeOAuth = provider === "claude" && (connection.authType === "oauth"
    || (!connection.authType && !!connection.accessToken));
  if (claudeOAuth) {
    config = { ...config, authHeader: "Authorization", authPrefix: "Bearer ",
      headers: { ...config.headers, "anthropic-beta": "oauth-2025-04-20" } };
  }
  const scope = config.listingScope || (provider === "opencode-go" ? "public" : "account");
  try {
    let result;
    if (typeof config.customResolver === "function") {
      result = await config.customResolver(connection);
      if (!result || result.error || result.warning) {
        return { error: result?.error || "Official model discovery failed", status: result?.status || 502 };
      }
    } else {
      const token = provider === "claude"
        ? (claudeOAuth ? connection.accessToken : connection.apiKey)
        : connection.providerSpecificData?.copilotToken || connection.accessToken || connection.apiKey;
      if ((config.authHeader || config.authQuery) && !token) return { error: "No valid token found", status: 401 };
      const url = new URL(typeof config.url === "function" ? config.url(connection) : config.url);
      if (config.authQuery) url.searchParams.set(config.authQuery, token);
      const headers = { ...config.headers };
      if (config.authHeader) headers[config.authHeader] = (config.authPrefix || "") + token;
      let options = { method: config.method || "GET", headers, cache: "no-store", signal: AbortSignal.timeout(15000) };
      if (config.body && options.method === "POST") options.body = JSON.stringify(config.body);
      let refreshAttempted = false;
      const allModels = [];
      const seenPages = new Set();
      for (let page = 0; page < 100; page += 1) {
        const pageUrl = url.toString();
        if (seenPages.has(pageUrl)) throw new Error("Official directory pagination did not advance");
        seenPages.add(pageUrl);
        let response = await fetch(pageUrl, options);
        if (claudeOAuth && !refreshAttempted && [401, 403].includes(response.status) && connection.refreshToken) {
          refreshAttempted = true;
          // Reuse the existing deduplicated refresh transport. A refresh failure
          // preserves the original safe HTTP error, never upstream diagnostics.
          const refreshed = await refreshClaudeOAuthToken(connection.refreshToken).catch(() => null);
          if (refreshed?.accessToken) {
            const credentials = {
              accessToken: refreshed.accessToken,
              refreshToken: refreshed.refreshToken || connection.refreshToken,
              expiresIn: refreshed.expiresIn,
            };
            if (!await updateProviderCredentials(connection.id, credentials)) {
              return { error: "Failed to save refreshed Claude credentials", status: 502 };
            }
            Object.assign(connection, credentials);
            // New options avoid mutating the previous request's headers and give
            // the retry its own deadline after the refresh has completed.
            options = { ...options, headers: { ...options.headers, Authorization: `Bearer ${credentials.accessToken}` },
              signal: AbortSignal.timeout(15000) };
            response = await fetch(pageUrl, options);
          }
        }
        if (!response.ok) return await modelDiscoveryHttpError(response, provider);
        let data;
        try { data = await response.json(); } catch { return { error: "Upstream returned an invalid model list", status: 502 }; }
        if (data?.error || data?.warning || data?.success === false || (data?.code !== undefined && ![0, 200, "0", "200"].includes(data.code))) {
          return { error: "Upstream returned an invalid model list", status: 502 };
        }
        const parsedFalPage = config.pagination === "fal-cursor" ? parseFalModelPage(data) : null;
        const models = parsedFalPage?.models || config.parseResponse(data);
        allModels.push(...models);
        const cursor = parsedFalPage?.nextCursor || null;
        const token = data.next_page_token || data.nextPageToken;
        if (cursor) {
          url.searchParams.set("cursor", cursor);
        } else if (token) {
          url.searchParams.set(provider === "gemini" ? "pageToken" : "page_token", token);
        } else if (config.pagination !== "fal-cursor" && data.has_more === true) {
          const lastId = data.last_id || data.lastId;
          if (!lastId) return { error: "Official directory is incomplete", status: 502 };
          url.searchParams.set(["anthropic", "claude"].includes(provider) ? "after_id" : "after", lastId);
        } else {
          result = { models: allModels };
          break;
        }
      }
      if (!result) return { error: "Official directory exceeded pagination limit", status: 502 };
    }
    const models = validateOfficialModels(result.models);
    return { provider, connectionId: connection.id || null, models, listingScope: result.listingScope || scope,
      discovery: officialDiscovery(models, result.listingScope || scope) };
  } catch (error) {
    return { error: error.message === "Upstream returned an invalid model list" ? error.message : "Failed to fetch models", status: error.message === "Upstream returned an invalid model list" ? 502 : 500 };
  }
}
