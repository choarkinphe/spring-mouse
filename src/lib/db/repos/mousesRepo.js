import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const MOUSE_TOKEN_PREFIX = "mse_";
const REGISTRATION_TOKEN_PREFIX = "msr_";
export const MOUSE_ONLINE_TIMEOUT_MS = 90_000;

function hashToken(value) {
  return createHash("sha256").update(String(value)).digest("hex");
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
    name: row.name,
    version: row.version || null,
    capabilities: parseJson(row.capabilities, []),
    metadata: parseJson(row.metadata, {}),
    registrationIp: row.registrationIp || null,
    lastHeartbeatAt: row.lastHeartbeatAt || null,
    registeredAt: row.registeredAt,
    updatedAt: row.updatedAt,
    disabledAt: row.disabledAt || null,
    isOnline: isOnline(row, now),
    status: disabled ? "disabled" : isOnline(row, now) ? "online" : "offline",
  };
}

function rowToRegistrationToken(row, now = Date.now()) {
  if (!row) return null;
  const expired = Date.parse(row.expiresAt) <= now;
  const used = Boolean(row.usedAt);
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    usedAt: row.usedAt || null,
    usedByMouseId: row.usedByMouseId || null,
    status: used ? "used" : expired ? "expired" : "active",
  };
}

function publicMouseWithSecret(row) {
  return { ...rowToMouse(row), accessTokenHash: undefined };
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

export async function getAvailableMouseById(id) {
  const mouse = await getMouseById(id);
  return mouse && !mouse.disabledAt && mouse.isOnline ? mouse : null;
}

export async function createMouseRegistrationToken({
  name,
  ttlSeconds = 600,
} = {}) {
  const token = `${REGISTRATION_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
  const now = new Date();
  const record = {
    id: randomUUID(),
    name: name || "Mouse registration token",
    tokenPrefix: token.slice(0, 13),
    expiresAt: new Date(now.getTime() + Math.max(30, Math.min(Number(ttlSeconds) || 600, 86_400)) * 1000).toISOString(),
    createdAt: now.toISOString(),
  };
  const db = await getAdapter();
  db.run(
    `INSERT INTO mouseRegistrationTokens(id, name, tokenPrefix, tokenHash, expiresAt, createdAt, usedAt, usedByMouseId)
     VALUES(?, ?, ?, ?, ?, ?, NULL, NULL)`,
    [record.id, record.name, record.tokenPrefix, hashToken(token), record.expiresAt, record.createdAt],
  );
  return { ...record, token };
}

export async function getMouseRegistrationTokens() {
  const db = await getAdapter();
  const now = Date.now();
  return db.all("SELECT * FROM mouseRegistrationTokens ORDER BY createdAt DESC").map((row) => rowToRegistrationToken(row, now));
}

export async function deleteMouseRegistrationToken(id) {
  const db = await getAdapter();
  const result = db.run("DELETE FROM mouseRegistrationTokens WHERE id = ?", [id]);
  return (result?.changes || 0) > 0;
}

export async function registerMouse({
  registrationToken,
  name,
  version,
  capabilities,
  metadata,
  registrationIp,
} = {}) {
  if (typeof registrationToken !== "string" || !registrationToken.startsWith(REGISTRATION_TOKEN_PREFIX)) {
    return { error: "invalid_registration_token" };
  }

  const db = await getAdapter();
  const tokenHash = hashToken(registrationToken);
  let result;
  db.transaction(() => {
    const tokenRow = db.get("SELECT * FROM mouseRegistrationTokens WHERE tokenHash = ?", [tokenHash]);
    const nowMs = Date.now();
    if (!tokenRow || tokenRow.usedAt || Date.parse(tokenRow.expiresAt) <= nowMs) {
      result = { error: "invalid_registration_token" };
      return;
    }

    const now = new Date(nowMs).toISOString();
    const mouse = {
      id: randomUUID(),
      name: (typeof name === "string" && name.trim()) || tokenRow.name || "Mouse",
      version: typeof version === "string" ? version.slice(0, 80) : null,
      capabilities: Array.isArray(capabilities) ? capabilities.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()) : [],
      metadata: metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {},
      registrationIp: registrationIp || null,
      lastHeartbeatAt: now,
      registeredAt: now,
      updatedAt: now,
      disabledAt: null,
    };
    const accessToken = `${MOUSE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;

    db.run(
      `INSERT INTO mouses(
        id, name, accessTokenHash, version, capabilities, metadata,
        registrationIp, lastHeartbeatAt, registeredAt, updatedAt, disabledAt
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        mouse.id,
        mouse.name,
        hashToken(accessToken),
        mouse.version,
        stringifyJson(mouse.capabilities),
        stringifyJson(mouse.metadata),
        mouse.registrationIp,
        mouse.lastHeartbeatAt,
        mouse.registeredAt,
        mouse.updatedAt,
      ],
    );
    db.run(
      "UPDATE mouseRegistrationTokens SET usedAt = ?, usedByMouseId = ? WHERE id = ?",
      [now, mouse.id, tokenRow.id],
    );

    result = {
      mouse: publicMouseWithSecret(db.get("SELECT * FROM mouses WHERE id = ?", [mouse.id])),
      accessToken,
    };
  });

  return result;
}

export async function authenticateMouseAccessToken(token) {
  if (typeof token !== "string" || !token.startsWith(MOUSE_TOKEN_PREFIX)) return null;
  const db = await getAdapter();
  const row = db.get("SELECT * FROM mouses WHERE accessTokenHash = ?", [hashToken(token)]);
  if (!row || row.disabledAt) return null;
  return rowToMouse(row);
}

export async function updateMouseHeartbeat(mouseId, { version, capabilities, metadata } = {}) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const row = db.get("SELECT * FROM mouses WHERE id = ?", [mouseId]);
  if (!row || row.disabledAt) return null;

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
    `UPDATE mouses SET version = ?, capabilities = ?, metadata = ?, lastHeartbeatAt = ?, updatedAt = ? WHERE id = ?`,
    [nextVersion, stringifyJson(nextCapabilities), stringifyJson(nextMetadata), now, now, mouseId],
  );
  return rowToMouse(db.get("SELECT * FROM mouses WHERE id = ?", [mouseId]));
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
