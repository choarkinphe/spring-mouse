import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const MOUSE_ACCESS_TOKEN_PREFIX = "mst_";
const MOUSE_EXECUTION_TOKEN_PREFIX = "msx_";
export const MOUSE_ONLINE_TIMEOUT_MS = 90_000;

function hashToken(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function generateAccessToken() {
  return `${MOUSE_ACCESS_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
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

// The dashboard names a node before it ever connects, so the client id has to be
// allocated up front: `clientId` is NOT NULL and UNIQUE on every install, and two
// nodes must never race for the same one at registration time. Names without
// ASCII characters collapse to an id-only slug instead of an empty prefix.
function deriveClientId(name, id) {
  const slug = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9._:@-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "")
    .slice(0, 40);
  const suffix = String(id).slice(0, 8);
  return normalizeClientId(slug ? `${slug}-${suffix}` : `mouse-${suffix}`);
}

function isOnline(row, now = Date.now()) {
  if (!row?.lastHeartbeatAt || row.disabledAt) return false;
  const heartbeat = Date.parse(row.lastHeartbeatAt);
  return Number.isFinite(heartbeat) && now - heartbeat <= MOUSE_ONLINE_TIMEOUT_MS;
}

function rowToMouse(row, now = Date.now()) {
  if (!row) return null;
  const disabled = Boolean(row.disabledAt);
  // A node is "registered" once it has made contact at least once. Rows created
  // from the dashboard start out unregistered: the command has been handed out
  // but no agent has used it yet.
  const registered = Boolean(row.lastHeartbeatAt);
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
    registered,
    lastHeartbeatAt: row.lastHeartbeatAt || null,
    registeredAt: row.registeredAt,
    updatedAt: row.updatedAt,
    disabledAt: row.disabledAt || null,
    isOnline: isOnline(row, now),
    status: disabled
      ? "disabled"
      : !registered
        ? "unregistered"
        : isOnline(row, now)
          ? "online"
          : "offline",
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

// The access token is the node's identity: one token, one node. It is minted when
// the node is created in the dashboard and only its hash is ever stored, so the
// plaintext can be shown exactly once.
export async function getMouseByAccessToken(token) {
  if (typeof token !== "string" || !token.startsWith(MOUSE_ACCESS_TOKEN_PREFIX)) return null;
  const db = await getAdapter();
  return rowToMouse(db.get("SELECT * FROM mouses WHERE accessTokenHash = ?", [hashToken(token)]));
}

export async function createMouse({ name, callbackUrl } = {}) {
  const trimmedName = typeof name === "string" ? name.trim() : "";
  if (!trimmedName) return { validationError: "Name is required" };
  if (trimmedName.length > 80) return { validationError: "Name must be at most 80 characters" };

  const rawCallbackUrl = typeof callbackUrl === "string" ? callbackUrl.trim() : "";
  const normalizedCallbackUrl = rawCallbackUrl ? normalizeCallbackUrl(rawCallbackUrl) : null;
  if (rawCallbackUrl && !normalizedCallbackUrl) {
    return { validationError: "callbackUrl must be a valid HTTP or HTTPS URL" };
  }

  const id = randomUUID();
  const token = generateAccessToken();
  const now = new Date().toISOString();
  const db = await getAdapter();
  db.run(
    `INSERT INTO mouses(
      id, name, accessTokenHash, clientId, executionToken, callbackUrl, version,
      capabilities, metadata, registrationIp, lastHeartbeatAt, registeredAt, updatedAt, disabledAt
    ) VALUES(?, ?, ?, ?, NULL, ?, NULL, '[]', '{}', NULL, NULL, ?, ?, NULL)`,
    [id, trimmedName, hashToken(token), deriveClientId(trimmedName, id), normalizedCallbackUrl, now, now],
  );
  return { mouse: rowToMouse(db.get("SELECT * FROM mouses WHERE id = ?", [id])), token };
}

// Re-issues the access token for a node that never used the one it was given, or
// whose command has to be handed out again. The previous token stops working.
export async function rotateMouseToken(id) {
  if (!id) return null;
  const db = await getAdapter();
  if (!db.get("SELECT id FROM mouses WHERE id = ?", [id])) return null;
  const token = generateAccessToken();
  const now = new Date().toISOString();
  db.run("UPDATE mouses SET accessTokenHash = ?, updatedAt = ? WHERE id = ?", [hashToken(token), now, id]);
  return { token, mouse: rowToMouse(db.get("SELECT * FROM mouses WHERE id = ?", [id])) };
}

// Registration claims the row that already carries this token: the identity comes
// from the token, not from whatever clientId the agent happens to send, so a node
// provisioned from the dashboard can never land on a second row.
export async function registerMouse({
  mouseToken,
  version,
  capabilities,
  metadata,
  registrationIp,
  callbackUrl,
} = {}) {
  const mouse = await getMouseByAccessToken(mouseToken);
  if (!mouse) return { error: "invalid_mouse_token" };
  if (mouse.disabledAt) return { error: "mouse_disabled" };

  const normalizedCallbackUrl = normalizeCallbackUrl(callbackUrl);
  if (!normalizedCallbackUrl) return { error: "invalid_callback_url" };

  const db = await getAdapter();
  const executionToken = `${MOUSE_EXECUTION_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const nextVersion = typeof version === "string" ? version.slice(0, 80) : null;
  const nextCapabilities = Array.isArray(capabilities)
    ? capabilities.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
    : [];
  const nextMetadata = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};

  db.run(
    `UPDATE mouses SET executionToken = ?, callbackUrl = ?, version = ?, capabilities = ?,
      metadata = ?, registrationIp = ?, lastHeartbeatAt = ?, updatedAt = ?
     WHERE id = ?`,
    [
      executionToken,
      normalizedCallbackUrl,
      nextVersion,
      stringifyJson(nextCapabilities),
      stringifyJson(nextMetadata),
      registrationIp || null,
      now,
      now,
      mouse.id,
    ],
  );

  const updated = rowToMouse(db.get("SELECT * FROM mouses WHERE id = ?", [mouse.id]), nowMs);
  return { mouse: updated, executionToken };
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

export async function updateMouse(id, { name, disabled, callbackUrl } = {}) {
  const db = await getAdapter();
  const row = db.get("SELECT * FROM mouses WHERE id = ?", [id]);
  if (!row) return null;
  const now = new Date().toISOString();
  const nextName = name === undefined ? row.name : String(name).trim().slice(0, 80);
  if (!nextName) return { validationError: "Name is required" };
  const nextDisabledAt = disabled === undefined ? row.disabledAt : disabled ? now : null;
  // The start command embeds the callback URL, so it stays editable until the node
  // actually registers (registration overwrites it with what the agent reports).
  let nextCallbackUrl = row.callbackUrl;
  if (callbackUrl !== undefined) {
    if (callbackUrl === null || callbackUrl === "") {
      nextCallbackUrl = null;
    } else {
      nextCallbackUrl = normalizeCallbackUrl(callbackUrl);
      if (!nextCallbackUrl) return { validationError: "callbackUrl must be a valid HTTP or HTTPS URL" };
    }
  }

  db.run(
    "UPDATE mouses SET name = ?, callbackUrl = ?, disabledAt = ?, updatedAt = ? WHERE id = ?",
    [nextName, nextCallbackUrl, nextDisabledAt, now, id],
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
