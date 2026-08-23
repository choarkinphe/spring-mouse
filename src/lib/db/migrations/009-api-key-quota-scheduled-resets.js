const WINDOWS = [
  { field: "fiveHourQuotaResetAt", durationMs: 5 * 60 * 60 * 1000 },
  { field: "weeklyQuotaResetAt", durationMs: 7 * 24 * 60 * 60 * 1000 },
];

function nextBoundary(value, durationMs, nowMs) {
  const time = value ? new Date(value).getTime() : Number.NaN;
  if (!Number.isFinite(time)) return new Date(nowMs + durationMs).toISOString();
  let next = time + durationMs; // pre-v9 values represented the reset start
  while (next <= nowMs) next += durationMs;
  return new Date(next).toISOString();
}

export default {
  version: 9,
  name: "api-key-quota-scheduled-resets",
  up(db) {
    const nowMs = Date.now();
    const keys = db.all(`SELECT id, createdAt, quotaResetAt, fiveHourQuotaResetAt, weeklyQuotaResetAt FROM apiKeys`);
    for (const key of keys) {
      const updates = WINDOWS.map(({ field, durationMs }) => nextBoundary(key[field] || key.quotaResetAt || key.createdAt, durationMs, nowMs));
      db.run(`UPDATE apiKeys SET quotaResetAt = NULL, fiveHourQuotaResetAt = ?, weeklyQuotaResetAt = ? WHERE id = ?`, [...updates, key.id]);
    }
  },
};
