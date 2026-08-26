import { getAdapter } from "../driver.js";
import { stringifyJson, parseJson } from "../helpers/jsonCol.js";

function normalizeBytes(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function buildTrafficFilter({ startDate, endDate, apiKeyId } = {}, alias = "nt") {
  const conditions = [];
  const params = [];

  if (startDate) {
    conditions.push(`${alias}.timestamp >= ?`);
    params.push(new Date(startDate).toISOString());
  }
  if (endDate) {
    conditions.push(`${alias}.timestamp <= ?`);
    params.push(new Date(endDate).toISOString());
  }
  if (apiKeyId) {
    conditions.push(`EXISTS (SELECT 1 FROM usageHistory uh WHERE uh.trafficRequestId = ${alias}.requestId AND uh.apiKeyId = ?)`);
    params.push(apiKeyId);
  }

  return { where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", params };
}

function startOfLocalDay(date = new Date()) {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value;
}

function currentTrafficRanges() {
  const now = new Date();
  const today = startOfLocalDay(now);
  const week = startOfLocalDay(now);
  week.setDate(week.getDate() - ((week.getDay() + 6) % 7));
  const month = startOfLocalDay(now);
  month.setDate(1);
  return { today, week, month, now };
}

function mapTotals(row) {
  const requestBytes = normalizeBytes(row?.requestBytes);
  const responseBytes = normalizeBytes(row?.responseBytes);
  return {
    requests: Number(row?.requests) || 0,
    requestBytes,
    responseBytes,
    totalBytes: requestBytes + responseBytes,
  };
}

export async function saveNetworkTraffic(record) {
  const db = await getAdapter();
  const requestBytes = normalizeBytes(record.requestBytes);
  const responseBytes = normalizeBytes(record.responseBytes);
  const timestamp = record.timestamp || new Date().toISOString();
  const completedAt = record.completedAt || timestamp;

  db.run(
    `INSERT INTO networkTraffic(requestId, timestamp, completedAt, method, endpoint, statusCode, requestBytes, responseBytes, durationMs, aborted, meta)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(requestId) DO UPDATE SET
       completedAt = excluded.completedAt,
       statusCode = excluded.statusCode,
       requestBytes = excluded.requestBytes,
       responseBytes = excluded.responseBytes,
       durationMs = excluded.durationMs,
       aborted = excluded.aborted,
       meta = excluded.meta`,
    [
      record.requestId,
      timestamp,
      completedAt,
      record.method || "GET",
      record.endpoint || "Unknown",
      Number(record.statusCode) || 0,
      requestBytes,
      responseBytes,
      Math.max(0, Number(record.durationMs) || 0),
      record.aborted ? 1 : 0,
      stringifyJson(record.meta || {}),
    ],
  );

  try {
    const { notifyUsageCommitted } = await import("./usageRepo.js");
    notifyUsageCommitted();
  } catch {}
}

export async function getTrafficTotals(range = {}) {
  const db = await getAdapter();
  const { where, params } = buildTrafficFilter(range);
  const row = db.get(
    `SELECT COUNT(*) AS requests, COALESCE(SUM(requestBytes), 0) AS requestBytes, COALESCE(SUM(responseBytes), 0) AS responseBytes
       FROM networkTraffic nt ${where}`,
    params,
  );
  return mapTotals(row);
}

export async function getTrafficSummary({ apiKeyId = null, recentLimit = 12 } = {}) {
  const db = await getAdapter();
  const { today, week, month, now } = currentTrafficRanges();
  const endDate = now.toISOString();

  const [todayTotals, weekTotals, monthTotals] = await Promise.all([
    getTrafficTotals({ startDate: today.toISOString(), endDate, apiKeyId }),
    getTrafficTotals({ startDate: week.toISOString(), endDate, apiKeyId }),
    getTrafficTotals({ startDate: month.toISOString(), endDate, apiKeyId }),
  ]);

  const { where, params } = buildTrafficFilter({ apiKeyId });
  const recent = db.all(
    `SELECT requestId, timestamp, completedAt, method, endpoint, statusCode, requestBytes, responseBytes, durationMs, aborted, meta
       FROM networkTraffic nt ${where}
      ORDER BY timestamp DESC
      LIMIT ?`,
    [...params, Math.max(1, Math.min(50, Number(recentLimit) || 12))],
  ).map((row) => {
    const requestBytes = normalizeBytes(row.requestBytes);
    const responseBytes = normalizeBytes(row.responseBytes);
    const meta = parseJson(row.meta, {}) || {};
    return {
      requestId: row.requestId,
      timestamp: row.timestamp,
      completedAt: row.completedAt,
      method: row.method,
      endpoint: row.endpoint,
      statusCode: Number(row.statusCode) || 0,
      requestBytes,
      responseBytes,
      totalBytes: requestBytes + responseBytes,
      durationMs: Math.max(0, Number(row.durationMs) || 0),
      aborted: row.aborted === 1,
      appName: meta.appName || null,
    };
  });

  return { today: todayTotals, week: weekTotals, month: monthTotals, recent };
}

export async function getTrafficBuckets({ startTime, endTime, bucketMs, bucketCount, apiKeyId = null }) {
  const db = await getAdapter();
  const startIso = new Date(startTime).toISOString();
  const endIso = new Date(endTime).toISOString();
  const { where: extraWhere, params: extraParams } = buildTrafficFilter({ apiKeyId });
  const apiKeyCondition = extraWhere ? extraWhere.replace(/^WHERE\s+/, " AND ") : "";
  const rows = db.all(
    `SELECT
       CAST(((julianday(nt.timestamp) - julianday(?)) * 86400000.0) / ? AS INTEGER) AS bucketIndex,
       COALESCE(SUM(nt.requestBytes), 0) AS requestBytes,
       COALESCE(SUM(nt.responseBytes), 0) AS responseBytes
     FROM networkTraffic nt
     WHERE nt.timestamp >= ? AND nt.timestamp <= ?${apiKeyCondition}
     GROUP BY bucketIndex
     ORDER BY bucketIndex`,
    [startIso, bucketMs, startIso, endIso, ...extraParams],
  );

  const buckets = Array.from({ length: bucketCount }, () => ({ requestBytes: 0, responseBytes: 0, trafficBytes: 0 }));
  for (const row of rows) {
    const index = Number(row.bucketIndex);
    if (index < 0 || index >= bucketCount) continue;
    const requestBytes = normalizeBytes(row.requestBytes);
    const responseBytes = normalizeBytes(row.responseBytes);
    buckets[index] = { requestBytes, responseBytes, trafficBytes: requestBytes + responseBytes };
  }
  return buckets;
}
