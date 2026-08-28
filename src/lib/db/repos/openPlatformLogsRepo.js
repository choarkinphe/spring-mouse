import { getAdapter } from "../driver.js";

function rowToLog(row) {
  return {
    id: row.id,
    apiKeyId: row.apiKeyId,
    keyName: row.keyName,
    keyPrefix: row.keyPrefix,
    timestamp: row.timestamp,
    method: row.method,
    path: row.path,
    statusCode: row.statusCode,
    durationMs: row.durationMs || 0,
    sourceIp: row.sourceIp || null,
    userAgent: row.userAgent || null,
    subjectUserId: row.subjectUserId || null,
  };
}

export async function recordOpenPlatformApiCall(entry) {
  const db = await getAdapter();
  const timestamp = entry.timestamp || new Date().toISOString();
  const result = db.run(
    `INSERT INTO openPlatformApiCallLogs(apiKeyId, keyName, keyPrefix, timestamp, method, path, statusCode, durationMs, sourceIp, userAgent, subjectUserId) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.apiKeyId,
      entry.keyName,
      entry.keyPrefix,
      timestamp,
      entry.method,
      entry.path,
      entry.statusCode,
      Math.max(0, Number(entry.durationMs) || 0),
      entry.sourceIp || null,
      entry.userAgent || null,
      entry.subjectUserId || null,
    ],
  );
  return { id: result?.lastInsertRowid ?? null, ...entry, timestamp };
}

export async function getOpenPlatformApiCallLogs({ apiKeyId = null, page = 1, pageSize = 30 } = {}) {
  const db = await getAdapter();
  const conditions = [];
  const params = [];
  if (apiKeyId) {
    conditions.push("apiKeyId = ?");
    params.push(apiKeyId);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const normalizedPage = Math.max(1, Number(page) || 1);
  const normalizedPageSize = Math.min(100, Math.max(1, Number(pageSize) || 30));
  const offset = (normalizedPage - 1) * normalizedPageSize;
  const totalItems = db.get(`SELECT COUNT(*) AS total FROM openPlatformApiCallLogs ${where}`, params)?.total || 0;
  const rows = db.all(
    `SELECT * FROM openPlatformApiCallLogs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, normalizedPageSize, offset],
  );
  return {
    logs: rows.map(rowToLog),
    pagination: {
      page: normalizedPage,
      pageSize: normalizedPageSize,
      totalItems,
      totalPages: Math.ceil(totalItems / normalizedPageSize),
    },
  };
}
