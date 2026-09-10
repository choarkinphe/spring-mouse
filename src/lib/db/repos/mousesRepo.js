import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const MOUSE_ACCESS_TOKEN_PREFIX = "mst_";
const MOUSE_EXECUTION_TOKEN_PREFIX = "msx_";
export const MOUSE_ONLINE_TIMEOUT_MS = 90_000;

function hashToken(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function normalizeCallbackUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function normalizeClientId(value) {
  if (typeof value !== "string") return null;
  const clientId = value.trim();
  if (!clientId || clientId.length > 100 || !/^[a-zA-Z0-9._:@-]+$/.test(clientId)) return null;
  return clientId;
}

function isOnline(row, now = Date.now()) {
  if (!row?.lastHeartbeatAt || row.disabledAt) return false;
  const heartbeat = Date.parse(row.lastHeartbeatAt);
  return Number.isFinite(heartbeat) && now - heartbeat <= MOUSE_ONLINE_TIMEOUT_MS;
}

function rowToMouse(row, now = Date.now()) {
  if (!row) return null;
  const disabled = Boolean(row.disabledAt);
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    version: row.version || null,
    capabilities: parseJson(row.capabilities, []),
    metadata: parseJson(row.metadata, {}),
    registrationIp: row.registrationIp || null,
    callbackUrl: row.callbackUrl || null,
    executionTokenConfigured: Boolean(row.executionToken),
    lastHeartbeatAt: row.lastHeartbeatAt || null,
    registeredAt: row.registeredAt,
    updatedAt: row.updatedAt,
    disabledAt: row.disabledAt || null,
    isOnline: isOnline(row, now),
    status: disabled ? "disabled" : isOnline(row, now) ? "online" : "offline",
  };
}

function rowToAccessToken(row, now = Date.now()) {
  if (!row) return null;
  const revoked = Boolean(row.revokedAt);
  const expired = Boolean(row.expiresAt) && Date.parse(row.expiresAt) <= now;
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    expiresAt: row.expiresAt || null,
    createdAt: row.createdAt,
    rotatedAt: row.rotatedAt || null,
    revokedAt: row.revokedAt || null,
    status: revoked ? "revoked" : expired ? "expired" : "active",
  };
}

export async function getMouses() {
  const db = await getAdapter();
  return db.all("SELECT * FROM mouses ORDER BY registeredAt DESC").map((row) => rowToMouse(row));
}

export async function getMouseById(id) {
  if (!id) return null;
  const db = await getAdapter();
  return rowToMouse(db.get("SELECT * FROM mouses WHERE id = ?", [id]));
}

export async function getMouseByClientId(clientId) {
  if (!clientId) return null;
  const db = await getAdapter();
  return rowToMouse(db.get("SELECT * FROM mouses WHERE clientId = ?", [clientId]));
}

export async function getAvailableMouseById(id) {
  const mouse = await getMouseById(id);
  return mouse && !mouse.disabledAt && mouse.isOnline && mouse.callbackUrl && mouse.executionTokenConfigured
    ? mouse
    : null;
}

export async function getMouseExecutionDetails(id) {
  if (!id) return null;
  const db = await getAdapter();
  const row = db.get("SELECT * FROM mouses WHERE id = ?", [id]);
  if (!row || row.disabledAt || !row.executionToken || !row.callbackUrl) return null;
  if (!isOnline(row)) return null;
  return { mouseId: row.id, callbackUrl: row.callbackUrl, executionToken: row.executionToken };
}

function normalizeExpiresAt(ttlSeconds, now = new Date()) {
  if (ttlSeconds === null || ttlSeconds === 0 || ttlSeconds === "0") return null;
  const ttl = Number(ttlSeconds);
  if (!Number.isFinite(ttl)) return undefined;
  return new Date(now.getTime() + Math.max(30, Math.min(ttl, 86_400 * 365)) * 1000).toISOString();
}

export async function createMouseAccessToken({ name, ttlSeconds = null } = {}) {
  const expiresAt = normalizeExpiresAt(ttlSeconds);
  if (expiresAt === undefined) throw new Error("Invalid token TTL");
  const token = `${MOUSE_ACCESS_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
  const now = new Date().toISOString();
  const record = {
    id: randomUUID(),
    name: (name || "Mouse access token").slice(0, 80),
    tokenPrefix: token.slice(0, 13),
    expiresAt,
    createdAt: now,
  };
  const db = await getAdapter();
  db.run(
    `INSERT INTO mouseAccessTokens(id, name, tokenPrefix, tokenHash, expiresAt, createdAt, rotatedAt, revokedAt)
     VALUES(?, ?, ?, ?, ?, ?, NULL, NULL)`,
    [record.id, record.name, record.tokenPrefix, hashToken(token), record.expiresAt, record.createdAt],
  );
  return { ...record, token };
}

export async function getMouseAccessTokens() {
  const db = await getAdapter();
  const now = Date.now();
  return db.all("SELECT * FROM mouseAccessTokens ORDER BY createdAt DESC").map((row) => rowToAccessToken(row, now));
}

export async function deleteMouseAccessToken(id) {
  const db = await getAdapter();
  const result = db.run("DELETE FROM mouseAccessTokens WHERE id = ?", [id]);
  return (result?.changes || 0) > 0;
}

export async function rotateMouseAccessToken(id, { ttlSeconds = null } = {}) {
  const expiresAt = normalizeExpiresAt(ttlSeconds);
  if (expiresAt === undefined) throw new Error("Invalid token TTL");
  const token = `${MOUSE_ACCESS_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
  const now = new Date().toISOString();
  const db = await getAdapter();
  const result = db.run(
    "UPDATE mouseAccessTokens SET tokenPrefix = ?, tokenHash = ?, expiresAt = ?, rotatedAt = ?, revokedAt = NULL WHERE id = ?",
    [token.slice(0, 13), hashToken(token), expiresAt, now, id],
  );
  return (result?.changes || 0) > 0 ? { token, expiresAt } : null;
}

export async function authenticateMouseAccessToken(token) {
  if (typeof token !== "string" || !token.startsWith(MOUSE_ACCESS_TOKEN_PREFIX)) return null;
  const db = await getAdapter();
  const row = db.get("SELECT * FROM mouseAccessTokens WHERE tokenHash = ?", [hashToken(token)]);
  if (!row || row.revokedAt) return null;
  if (row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) return null;
  return rowToAccessToken(row);
}

export async function registerMouse({
  mouseToken,
  clientId,
  name,
  version,
  capabilities,
  metadata,
  registrationIp,
  callbackUrl,
} = {}) {
  const tokenRow = await authenticateMouseAccessToken(mouseToken);
  if (!tokenRow) return { error: "invalid_mouse_token" };

  const normalizedClientId = normalizeClientId(clientId);
  if (!normalizedClientId) return { error: "invalid_client_id" };
  const normalizedCallbackUrl = normalizeCallbackUrl(callbackUrl);
  if (!normalizedCallbackUrl) return { error: "invalid_callback_url" };

  const db = await getAdapter();
  let result;
  db.transaction(() => {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const executionToken = `${MOUSE_EXECUTION_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
    const nextName = ((typeof name === "string" && name.trim()) || normalizedClientId).slice(0, 80);
    const nextVersion = typeof version === "string" ? version.slice(0, 80) : null;
    const nextCapabilities = Array.isArray(capabilities)
      ? capabilities.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
      : [];
    const nextMetadata = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
    const existingRow = db.get("SELECT * FROM mouses WHERE clientId = ?", [normalizedClientId]);
    let mouseId;

    if (existingRow) {
      if (existingRow.disabledAt) {
        result = { error: "client_id_disabled" };
        return;
      }
      mouseId = existingRow.id;
      db.run(
        `UPDATE mouses SET name = ?, version = ?, capabilities = ?, metadata = ?, callbackUrl = ?,
          executionToken = ?, lastHeartbeatAt = ?, updatedAt = ?
         WHERE id = ?`,
        [
          nextName,
          nextVersion,
          stringifyJson(nextCapabilities),
          stringifyJson(nextMetadata),
          normalizedCallbackUrl,
          executionToken,
          now,
          now,
          mouseId,
        ],
      );
    } else {
      mouseId = randomUUID();
      db.run(
        `INSERT INTO mouses(
          id, clientId, name, accessTokenHash, executionToken, callbackUrl, version,
          capabilities, metadata, registrationIp, lastHeartbeatAt, registeredAt, updatedAt, disabledAt
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
          mouseId,
          normalizedClientId,
          nextName,
          hashToken(`${normalizedClientId}:${randomUUID()}`),
          executionToken,
          normalizedCallbackUrl,
          nextVersion,
          stringifyJson(nextCapabilities),
          stringifyJson(nextMetadata),
          registrationIp || null,
          now,
          now,
          now,
        ],
      );
    }

    const mouse = rowToMouse(db.get("SELECT * FROM mouses WHERE id = ?", [mouseId]), nowMs);
    result = { mouse, executionToken };
  });

  return result;
}

export async function updateMouseHeartbeat(clientId, { version, capabilities, metadata } = {}) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const row = db.get("SELECT * FROM mouses WHERE clientId = ?", [clientId]);
  if (!row || row.disabledAt) return null;
  const nextCallbackUrl = metadata?.callbackUrl === undefined
    ? row.callbackUrl
    : normalizeCallbackUrl(metadata.callbackUrl);
  const nextVersion = version === undefined ? row.version : typeof version === "string" ? version.slice(0, 80) : null;
  const nextCapabilities = capabilities === undefined
    ? parseJson(row.capabilities, [])
    : Array.isArray(capabilities)
      ? capabilities.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
      : [];
  const currentMetadata = parseJson(row.metadata, {});
  const nextMetadata = metadata === undefined
    ? currentMetadata
    : metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? { ...currentMetadata, ...metadata }
      : currentMetadata;

  db.run(
    `UPDATE mouses SET callbackUrl = ?, version = ?, capabilities = ?, metadata = ?, lastHeartbeatAt = ?, updatedAt = ?
     WHERE clientId = ?`,
    [nextCallbackUrl, nextVersion, stringifyJson(nextCapabilities), stringifyJson(nextMetadata), now, now, clientId],
  );
  return rowToMouse(db.get("SELECT * FROM mouses WHERE clientId = ?", [clientId]));
}

export async function updateMouse(id, { name, disabled } = {}) {
  const db = await getAdapter();
  const row = db.get("SELECT * FROM mouses WHERE id = ?", [id]);
  if (!row) return null;
  const now = new Date().toISOString();
  const nextName = name === undefined ? row.name : String(name).trim().slice(0, 80);
  if (!nextName) return { validationError: "Name is required" };
  const nextDisabledAt = disabled === undefined ? row.disabledAt : disabled ? now : null;

  db.run(
    "UPDATE mouses SET name = ?, disabledAt = ?, updatedAt = ? WHERE id = ?",
    [nextName, nextDisabledAt, now, id],
  );
  return { mouse: rowToMouse(db.get("SELECT * FROM mouses WHERE id = ?", [id])) };
}

export async function deleteMouse(id) {
  const db = await getAdapter();
  let deleted = false;
  db.transaction(() => {
    db.run("UPDATE providerConnections SET mouseId = NULL WHERE mouseId = ?", [id]);
    const result = db.run("DELETE FROM mouses WHERE id = ?", [id]);
    deleted = (result?.changes || 0) > 0;
  });
  return deleted;
}

export async function rotateMouseExecutionToken(id) {
  const db = await getAdapter();
  const executionToken = `${MOUSE_EXECUTION_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
  const now = new Date().toISOString();
  const result = db.run(
    "UPDATE mouses SET executionToken = ?, updatedAt = ? WHERE id = ? AND disabledAt IS NULL",
    [executionToken, now, id],
  );
  if ((result?.changes || 0) === 0) return null;
  return { executionToken };
}
