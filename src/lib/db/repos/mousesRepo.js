import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const MOUSE_ACCESS_TOKEN_PREFIX = "mst_";
export const MOUSE_ONLINE_TIMEOUT_MS = 90_000;

function hashToken(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function generateAccessToken() {
  return `${MOUSE_ACCESS_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
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
  // but no agent has claimed the node with it yet.
  const registered = Boolean(row.lastHeartbeatAt);
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    version: row.version || null,
    capabilities: parseJson(row.capabilities, []),
    metadata: parseJson(row.metadata, {}),
    registrationIp: row.registrationIp || null,
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
  return mouse && !mouse.disabledAt && mouse.isOnline ? mouse : null;
}

// Everything Spring needs to hand a provider request to a node. There is no
// address here on purpose: the request leaves over the node's inbound tunnel,
// so a reachable hostname is not part of the contract any more.
export async function getMouseExecutionDetails(id) {
  if (!id) return null;
  const db = await getAdapter();
  const row = db.get("SELECT * FROM mouses WHERE id = ?", [id]);
  if (!row || row.disabledAt) return null;
  return { mouseId: row.id };
}

// The access token is the node's identity: one token, one node. It is minted when
// the node is created in the dashboard and only its hash is ever stored, so the
// plaintext can be shown exactly once.
export async function getMouseByAccessToken(token) {
  if (typeof token !== "string" || !token.startsWith(MOUSE_ACCESS_TOKEN_PREFIX)) return null;
  const db = await getAdapter();
  return rowToMouse(db.get("SELECT * FROM mouses WHERE accessTokenHash = ?", [hashToken(token)]));
}

export async function createMouse({ name } = {}) {
  const trimmedName = typeof name === "string" ? name.trim() : "";
  if (!trimmedName) return { validationError: "Name is required" };
  if (trimmedName.length > 80) return { validationError: "Name must be at most 80 characters" };

  const id = randomUUID();
  const token = generateAccessToken();
  const now = new Date().toISOString();
  const db = await getAdapter();
  db.run(
    `INSERT INTO mouses(
      id, name, accessTokenHash, clientId, executionToken, version,
      capabilities, metadata, registrationIp, lastHeartbeatAt, registeredAt, updatedAt, disabledAt
    ) VALUES(?, ?, ?, ?, NULL, NULL, '[]', '{}', NULL, NULL, ?, ?, NULL)`,
    [id, trimmedName, hashToken(token), deriveClientId(trimmedName, id), now, now],
  );
  return { mouse: rowToMouse(db.get("SELECT * FROM mouses WHERE id = ?", [id])), token };
}

// Re-issues the access token for a node that never used the one it was given, or
// whose command has to be handed out again. The previous token stops working and
// any tunnel it was holding is dropped by the caller.
export async function rotateMouseToken(id) {
  if (!id) return null;
  const db = await getAdapter();
  if (!db.get("SELECT id FROM mouses WHERE id = ?", [id])) return null;
  const token = generateAccessToken();
  const now = new Date().toISOString();
  db.run("UPDATE mouses SET accessTokenHash = ?, updatedAt = ? WHERE id = ?", [hashToken(token), now, id]);
  return { token, mouse: rowToMouse(db.get("SELECT * FROM mouses WHERE id = ?", [id])) };
}

/**
 * Refreshes the node's liveness. Opening a tunnel — and every keepalive on it —
 * is proof the node is running, so the stream replaces the polling heartbeat
 * that used to be the only way a node could report in.
 *
 * The optional fields are the node's self-description, which it can only supply
 * on the request that opens the tunnel: keepalives update nothing but the clock.
 */
export async function touchMouseHeartbeat(id, { version, registrationIp } = {}) {
  if (!id) return null;
  const db = await getAdapter();
  const row = db.get("SELECT * FROM mouses WHERE id = ?", [id]);
  if (!row || row.disabledAt) return null;
  const now = new Date().toISOString();
  const nextVersion = typeof version === "string" && version.trim()
    ? version.trim().slice(0, 80)
    : row.version;
  db.run(
    "UPDATE mouses SET version = ?, registrationIp = ?, lastHeartbeatAt = ?, updatedAt = ? WHERE id = ?",
    [nextVersion, registrationIp || row.registrationIp || null, now, now, id],
  );
  return rowToMouse(db.get("SELECT * FROM mouses WHERE id = ?", [id]));
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
