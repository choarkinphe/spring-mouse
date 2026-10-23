/**
 * Collapse one-shot bonus packs into a single quota row.
 *
 * WorkBuddy accounts carry one recurring allowance plus a growing pile of one-shot
 * "Bonus Pack N" credits. Rendered individually they overflowed the account row and
 * the extras were silently cut off behind "+N 项配额". The recurring allowance keeps
 * its own row (it is the number that replenishes); the bonus packs become one
 * summary row with the combined remainder, and each pack stays in `detail` so the
 * row can show them on hover.
 *
 * Only entries explicitly marked `recurring === false` are folded, so every other
 * provider keeps rendering exactly as before.
 *
 * @param {Array<object>} quotas
 * @returns {Array<{quota: object, detail?: object[]}>}
 */
export function summarizeQuotaRows(quotas) {
  const list = Array.isArray(quotas) ? quotas : [];
  const bonus = list.filter((q) => q?.recurring === false);
  if (bonus.length < 2) return list.map((quota) => ({ quota }));

  const known = bonus.filter((q) => Number.isFinite(Number(q?.total)));
  const totalSum = known.reduce((sum, q) => sum + Number(q.total), 0);
  const usedSum = known.reduce((sum, q) => sum + (Number(q.used) || 0), 0);
  const unit = bonus.find((q) => q.unit)?.unit;
  const summary = {
    name: `赠送包 ${bonus.length} 项`,
    displayName: `赠送包 ${bonus.length} 项`,
    used: usedSum,
    total: totalSum,
    unlimited: false,
    recurring: false,
    // The earliest expiry is the actionable one: the next credit to disappear.
    resetAt: bonus.map((q) => q.resetAt).filter(Boolean).sort()[0] || null,
    ...(unit ? { unit } : {}),
  };

  const rows = [];
  let inserted = false;
  for (const quota of list) {
    if (quota?.recurring === false) {
      if (!inserted) { rows.push({ quota: summary, detail: bonus }); inserted = true; }
      continue;
    }
    rows.push({ quota });
  }
  return rows;
}
