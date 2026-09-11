// Public API barrel — all DB functions
import { getAdapter } from "./driver.js";
import { stringifyJson, parseJson } from "./helpers/jsonCol.js";

// Settings
export {
  getSettings, updateSettings, isCloudEnabled, getCloudUrl, exportSettings,
} from "./repos/settingsRepo.js";

// Provider connections
export {
  getProviderConnections, getProviderConnectionById,
  createProviderConnection, updateProviderConnection, updateProviderConnectionHealth,
  deleteProviderConnection, deleteProviderConnectionsByProvider,
  reorderProviderConnections, cleanupProviderConnections,
} from "./repos/connectionsRepo.js";

// Mouse agents
export {
  getMouses, getMouseById, getAvailableMouseById, getMouseExecutionDetails,
  getMouseByClientId,
  createMouseAccessToken, getMouseAccessTokens, deleteMouseAccessToken, rotateMouseAccessToken,
  normalizeClientId,
  registerMouse, authenticateMouseAccessToken, updateMouseHeartbeat,
  updateMouse, deleteMouse, rotateMouseExecutionToken,
  normalizeCallbackUrl, MOUSE_ONLINE_TIMEOUT_MS,
} from "./repos/mousesRepo.js";

// Provider nodes
export {
  getProviderNodes, getProviderNodeById,
  createProviderNode, updateProviderNode, deleteProviderNode,
} from "./repos/nodesRepo.js";

// API keys
export {
  getApiKeys, getApiKeyById, getApiKeyByValue, createApiKey, updateApiKey, deleteApiKey, validateApiKey,
} from "./repos/apiKeysRepo.js";

// Open platform API keys
export {
  getOpenPlatformApiKeys, getOpenPlatformApiKeyById, createOpenPlatformApiKey,
  updateOpenPlatformApiKey, deleteOpenPlatformApiKey, authenticateOpenPlatformApiKey,
} from "./repos/openPlatformKeysRepo.js";

// Open platform API call logs
export {
  recordOpenPlatformApiCall, getOpenPlatformApiCallLogs,
} from "./repos/openPlatformLogsRepo.js";

// Combos
export {
  getCombos, getComboById, getComboByName,
  createCombo, updateCombo, deleteCombo,
} from "./repos/combosRepo.js";

// Aliases (model + custom + mitm)
export {
  getModelAliases, setModelAlias, deleteModelAlias,
  getCustomModels, addCustomModel, syncCustomModels, deleteCustomModel, upsertModelCapabilities,
  getMitmAlias, setMitmAliasAll,
} from "./repos/aliasRepo.js";

// Pricing
export {
  getPricing, getPricingForModel, updatePricing, resetPricing, resetAllPricing,
} from "./repos/pricingRepo.js";

// Disabled models
export {
  getDisabledModels, getDisabledByProvider, disableModels, enableModels,
} from "./repos/disabledModelsRepo.js";

// Usage
export {
  statsEmitter, notifyUsageCommitted, trackPendingRequest, updatePendingRequestTokens, getActiveRequests,
  saveRequestUsage, getUsageHistory, getUsageDetails, getUsageStats, getChartData,
  getConnectionLastRequestAt,
  appendRequestLog, getRecentLogs,
} from "./repos/usageRepo.js";

// Request details
export {
  saveRequestDetail, getRequestDetails, getRequestDetailById, getDistinctProviders,
} from "./repos/requestDetailsRepo.js";

// Export/import full DB
export async function exportDb() {
  const db = await getAdapter();
  const { exportSettings } = await import("./repos/settingsRepo.js");

  const out = {
    settings: await exportSettings(),
    providerConnections: db.all(`SELECT * FROM providerConnections`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, provider: r.provider, authType: r.authType, name: r.name, email: r.email, priority: r.priority, mouseId: r.mouseId || null, isActive: r.isActive === 1, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    providerNodes: db.all(`SELECT * FROM providerNodes`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, type: r.type, name: r.name, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    apiKeys: db.all(`SELECT * FROM apiKeys`).map((r) => ({ id: r.id, key: r.key, name: r.name, machineId: r.machineId, isActive: r.isActive === 1, quotaMode: r.quotaMode || "unlimited", quotaResetAt: r.quotaResetAt || null, fiveHourQuotaResetAt: r.fiveHourQuotaResetAt || null, weeklyQuotaResetAt: r.weeklyQuotaResetAt || null, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt || null })),
    openPlatformApiKeys: db.all(`SELECT * FROM openPlatformApiKeys`).map((r) => ({ id: r.id, name: r.name, keyPrefix: r.keyPrefix, keyHash: r.keyHash, isActive: r.isActive === 1, createdAt: r.createdAt, updatedAt: r.updatedAt, lastUsedAt: r.lastUsedAt || null })),
    openPlatformApiCallLogs: db.all(`SELECT * FROM openPlatformApiCallLogs`),
    mouses: db.all(`SELECT * FROM mouses`).map((r) => ({
      id: r.id,
      clientId: r.clientId,
      name: r.name,
      accessTokenHash: r.accessTokenHash,
      executionToken: r.executionToken || null,
      callbackUrl: r.callbackUrl || null,
      version: r.version || null,
      capabilities: parseJson(r.capabilities, []),
      metadata: parseJson(r.metadata, {}),
      registrationIp: r.registrationIp || null,
      lastHeartbeatAt: r.lastHeartbeatAt || null,
      registeredAt: r.registeredAt,
      updatedAt: r.updatedAt,
      disabledAt: r.disabledAt || null,
    })),
    mouseAccessTokens: db.all(`SELECT * FROM mouseAccessTokens`).map((r) => ({
      id: r.id,
      name: r.name,
      tokenPrefix: r.tokenPrefix,
      tokenHash: r.tokenHash,
      expiresAt: r.expiresAt || null,
      createdAt: r.createdAt,
      rotatedAt: r.rotatedAt || null,
      revokedAt: r.revokedAt || null,
    })),
    combos: db.all(`SELECT * FROM combos`).map((r) => ({ id: r.id, name: r.name, kind: r.kind, models: parseJson(r.models, []), isActive: r.isActive !== 0, groupName: r.groupName || null, sortOrder: Number.isFinite(r.sortOrder) ? r.sortOrder : 0, capabilities: parseJson(r.capabilities, {}), createdAt: r.createdAt, updatedAt: r.updatedAt })),
    modelAliases: {},
    customModels: [],
    mitmAlias: {},
    pricing: {},
  };

  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'modelAliases'`)) out.modelAliases[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'customModels'`)) out.customModels.push(parseJson(r.value));
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'mitmAlias'`)) out.mitmAlias[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'pricing'`)) out.pricing[r.key] = parseJson(r.value);

  return out;
}

function normalizeApiKeyQuotaMode(mode) {
  return ["off", "limited", "unlimited"].includes(mode) ? mode : "unlimited";
}

export async function importDb(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid database payload");
  }
  const db = await getAdapter();

  db.transaction(() => {
    // Wipe all tables (keep _meta)
    db.run(`DELETE FROM settings`);
    db.run(`DELETE FROM providerConnections`);
    db.run(`DELETE FROM providerNodes`);
    db.run(`DELETE FROM apiKeys`);
    db.run(`DELETE FROM openPlatformApiKeys`);
    db.run(`DELETE FROM openPlatformApiCallLogs`);
    db.run(`DELETE FROM mouseAccessTokens`);
    db.run(`DELETE FROM mouses`);
    db.run(`DELETE FROM combos`);
    db.run(`DELETE FROM kv WHERE scope IN ('modelAliases', 'customModels', 'mitmAlias', 'pricing')`);

    // Settings
    if (payload.settings) {
      db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, [stringifyJson(payload.settings)]);
    }

    for (const c of payload.providerConnections || []) {
      const { id, provider, authType, name, email, priority, mouseId, isActive, createdAt, updatedAt, ...rest } = c;
      if (rest.providerSpecificData && typeof rest.providerSpecificData === "object") {
        delete rest.providerSpecificData.proxyPoolId;
      }
      db.run(
        `INSERT OR REPLACE INTO providerConnections(id, provider, authType, name, email, priority, mouseId, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, provider, authType || "oauth", name || null, email || null, priority || null, mouseId || null, isActive === false ? 0 : 1, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const n of payload.providerNodes || []) {
      const { id, type, name, createdAt, updatedAt, ...rest } = n;
      db.run(
        `INSERT OR REPLACE INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [id, type || null, name || null, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const k of payload.apiKeys || []) {
      db.run(
        `INSERT OR REPLACE INTO apiKeys(id, key, name, machineId, isActive, quotaMode, quotaResetAt, fiveHourQuotaResetAt, weeklyQuotaResetAt, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [k.id, k.key, k.name || null, k.machineId || null, k.isActive === false ? 0 : 1, normalizeApiKeyQuotaMode(k.quotaMode), k.quotaResetAt || null, k.fiveHourQuotaResetAt || null, k.weeklyQuotaResetAt || null, k.createdAt || new Date().toISOString()]
      );
    }
    for (const k of payload.openPlatformApiKeys || []) {
      db.run(
        `INSERT OR REPLACE INTO openPlatformApiKeys(id, name, keyPrefix, keyHash, isActive, createdAt, updatedAt, lastUsedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
        [k.id, k.name, k.keyPrefix, k.keyHash, k.isActive === false ? 0 : 1, k.createdAt || new Date().toISOString(), k.updatedAt || k.createdAt || new Date().toISOString(), k.lastUsedAt || null]
      );
    }
    for (const log of payload.openPlatformApiCallLogs || []) {
      db.run(
        `INSERT OR REPLACE INTO openPlatformApiCallLogs(id, apiKeyId, keyName, keyPrefix, timestamp, method, path, statusCode, durationMs, sourceIp, userAgent, subjectUserId) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [log.id, log.apiKeyId, log.keyName, log.keyPrefix, log.timestamp, log.method, log.path, log.statusCode, log.durationMs || 0, log.sourceIp || null, log.userAgent || null, log.subjectUserId || null]
      );
    }
    for (const m of payload.mouses || []) {
      db.run(
        `INSERT OR REPLACE INTO mouses(
          id, clientId, name, accessTokenHash, version, capabilities, metadata,
          registrationIp, executionToken, callbackUrl, lastHeartbeatAt, registeredAt, updatedAt, disabledAt
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          m.id,
          m.clientId,
          m.name,
          m.accessTokenHash,
          m.executionToken || null,
          m.callbackUrl || null,
          m.version || null,
          stringifyJson(m.capabilities || []),
          stringifyJson(m.metadata || {}),
          m.registrationIp || null,
          m.lastHeartbeatAt || null,
          m.registeredAt || new Date().toISOString(),
          m.updatedAt || m.registeredAt || new Date().toISOString(),
          m.disabledAt || null,
        ],
      );
    }
    for (const t of payload.mouseAccessTokens || []) {
      db.run(
        `INSERT OR REPLACE INTO mouseAccessTokens(
          id, name, tokenPrefix, tokenHash, expiresAt, createdAt, rotatedAt, revokedAt
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          t.id,
          t.name,
          t.tokenPrefix,
          t.tokenHash,
          t.expiresAt || null,
          t.createdAt || new Date().toISOString(),
          t.rotatedAt || null,
          t.revokedAt || null,
        ],
      );
    }
    for (const c of payload.combos || []) {
      db.run(
        `INSERT OR REPLACE INTO combos(id, name, kind, models, isActive, groupName, sortOrder, capabilities, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [c.id, c.name, c.kind || null, stringifyJson(c.models || []), c.isActive === false ? 0 : 1, c.groupName || null, Number.isFinite(c.sortOrder) ? c.sortOrder : 0, stringifyJson(c.capabilities || {}), c.createdAt || new Date().toISOString(), c.updatedAt || new Date().toISOString()]
      );
    }
    for (const [a, m] of Object.entries(payload.modelAliases || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`, [a, stringifyJson(m)]);
    }
    for (const m of payload.customModels || []) {
      const k = `${m.providerAlias}|${m.id}|${m.type || "llm"}`;
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, stringifyJson(m)]);
    }
    for (const [tool, mappings] of Object.entries(payload.mitmAlias || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('mitmAlias', ?, ?)`, [tool, stringifyJson(mappings || {})]);
    }
    for (const [provider, models] of Object.entries(payload.pricing || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('pricing', ?, ?)`, [provider, stringifyJson(models || {})]);
    }
  });

  return await exportDb();
}

// Eager init helper (optional)
export async function initDb() {
  await getAdapter();
}
