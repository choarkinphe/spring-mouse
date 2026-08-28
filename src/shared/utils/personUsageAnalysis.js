function maxOf(rows, key) {
  return Math.max(...rows.map((row) => Number(row[key]) || 0), 0);
}

function relative(value, max) {
  return max > 0 ? Math.min(1, Math.max(0, (value || 0) / max)) : 0;
}

function rankRows(rows, key) {
  const map = new Map();
  [...rows]
    .sort((a, b) => (b[key] || 0) - (a[key] || 0))
    .forEach((row, index) => map.set(row.key, index + 1));
  return map;
}

function quantile(values, position) {
  if (!values.length) return 0;
  const index = (values.length - 1) * position;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return values[lower];
  return values[lower] + (values[upper] - values[lower]) * (index - lower);
}

function summarizeMetric(rows, key) {
  const values = rows.map((row) => Number(row[key]) || 0).sort((a, b) => a - b);
  if (!values.length) return { average: 0, median: 0, p25: 0, p75: 0, min: 0, max: 0, range: 0 };
  const min = values[0];
  const max = values.at(-1);
  return {
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    median: quantile(values, 0.5),
    p25: quantile(values, 0.25),
    p75: quantile(values, 0.75),
    min,
    max,
    range: max - min,
  };
}

function getTier(score) {
  if (score >= 70) return { id: "high", label: "高投入", className: "border-emerald-500/20 bg-emerald-500/10 text-emerald-600" };
  if (score >= 40) return { id: "medium", label: "中投入", className: "border-amber-500/20 bg-amber-500/10 text-amber-600" };
  return { id: "low", label: "低投入", className: "border-slate-500/20 bg-slate-500/10 text-text-muted" };
}

export function buildPersonUsageAnalysis(people, totals) {
  const totalRequests = totals.totalRequests || people.reduce((sum, item) => sum + (item.requests || 0), 0);
  const totalTokens = totals.totalTokens || people.reduce((sum, item) => sum + (item.totalTokens || 0), 0);
  const totalCost = totals.totalCost || people.reduce((sum, item) => sum + (item.cost || 0), 0);
  const prepared = people.map((person) => {
    const firstUsedMs = person.firstUsed ? new Date(person.firstUsed).getTime() : NaN;
    const lastUsedMs = person.lastUsed ? new Date(person.lastUsed).getTime() : NaN;
    const spanMs = Number.isFinite(firstUsedMs) && Number.isFinite(lastUsedMs) && lastUsedMs >= firstUsedMs
      ? lastUsedMs - firstUsedMs : 0;
    const failedRequests = person.failedRequests || 0;
    const cancelledRequests = person.cancelledRequests || 0;
    const outcomeCount = (person.completedRequests || 0) + failedRequests + cancelledRequests;
    const completedRequests = outcomeCount
      ? (person.completedRequests || 0)
      : Math.max(0, (person.requests || 0) - failedRequests - cancelledRequests);
    const requestDurationMs = person.requestDurationMs || 0;
    const activeSessionDurationMs = person.activeSessionDurationMs || 0;
    const effectiveDurationMs = activeSessionDurationMs || requestDurationMs;
    const activeDays = person.activeDays || (person.requests ? 1 : 0);
    const modelCount = Object.keys(person.models || {}).length;
    return {
      ...person,
      displayName: person.keyName || person.apiKeyMasked || person.key,
      completedRequests,
      failedRequests,
      cancelledRequests,
      requestDurationMs,
      activeSessionDurationMs,
      effectiveDurationMs,
      activeDays,
      modelCount,
      spanMs,
      successRate: person.requests ? completedRequests / person.requests : 0,
      tokensPerRequest: person.requests ? person.totalTokens / person.requests : 0,
      averageRequestDurationMs: person.durationRequestCount ? requestDurationMs / person.durationRequestCount : 0,
      tokenShare: totalTokens ? person.totalTokens / totalTokens : 0,
      requestShare: totalRequests ? person.requests / totalRequests : 0,
    };
  });

  const maxTokens = maxOf(prepared, "totalTokens");
  const maxRequests = maxOf(prepared, "requests");
  const maxDuration = maxOf(prepared, "effectiveDurationMs");
  const maxDays = maxOf(prepared, "activeDays");
  const maxModels = maxOf(prepared, "modelCount");

  const scored = prepared.map((person) => {
    // The score is intentionally an AI-use reference indicator, not a direct work-performance score.
    const referenceScore = Math.round(
      relative(person.totalTokens, maxTokens) * 35
      + relative(person.requests, maxRequests) * 20
      + relative(person.effectiveDurationMs, maxDuration) * 18
      + relative(person.activeDays, maxDays) * 12
      + relative(person.modelCount, maxModels) * 5
      + person.successRate * 10,
    );
    return { ...person, referenceScore, tier: getTier(referenceScore) };
  }).sort((a, b) => b.referenceScore - a.referenceScore || b.totalTokens - a.totalTokens);

  const tokenRanks = rankRows(scored, "totalTokens");
  const requestRanks = rankRows(scored, "requests");
  const durationRanks = rankRows(scored, "effectiveDurationMs");
  const successRanks = rankRows(scored, "successRate");
  const rows = scored.map((person, index) => ({
    ...person,
    rank: index + 1,
    tokenRank: tokenRanks.get(person.key),
    requestRank: requestRanks.get(person.key),
    durationRank: durationRanks.get(person.key),
    successRank: successRanks.get(person.key),
    percentile: scored.length <= 1 ? 1 : 1 - index / (scored.length - 1),
  }));

  const tokenRows = [...rows].sort((a, b) => b.totalTokens - a.totalTokens);
  let tokenAccumulator = 0;
  let headCount = 0;
  for (const person of tokenRows) {
    tokenAccumulator += person.totalTokens;
    headCount += 1;
    if (tokenAccumulator / Math.max(totalTokens, 1) >= 0.8) break;
  }

  const totalActiveTime = rows.reduce((sum, person) => sum + person.effectiveDurationMs, 0);
  const activeTimePeople = rows.filter((person) => person.effectiveDurationMs > 0);
  const avg = (key) => rows.length ? rows.reduce((sum, person) => sum + (person[key] || 0), 0) / rows.length : 0;

  const benchmarks = {
    referenceScore: summarizeMetric(rows, "referenceScore"),
    requests: summarizeMetric(rows, "requests"),
    totalTokens: summarizeMetric(rows, "totalTokens"),
    effectiveDurationMs: summarizeMetric(rows, "effectiveDurationMs"),
    activeDays: summarizeMetric(rows, "activeDays"),
    successRate: summarizeMetric(rows, "successRate"),
    modelCount: summarizeMetric(rows, "modelCount"),
    cost: summarizeMetric(rows, "cost"),
  };

  return {
    rows,
    benchmarks,
    totalRequests,
    totalTokens,
    totalCost,
    totalActiveTime,
    headCount,
    headTokenShare: totalTokens ? tokenRows.slice(0, headCount).reduce((sum, person) => sum + person.totalTokens, 0) / totalTokens : 0,
    highCount: rows.filter((person) => person.tier.id === "high").length,
    mediumCount: rows.filter((person) => person.tier.id === "medium").length,
    lowCount: rows.filter((person) => person.tier.id === "low").length,
    durationCoverage: totalRequests ? rows.reduce((sum, person) => sum + (person.durationRequestCount || 0), 0) / totalRequests : 0,
    activeTimePeople: activeTimePeople.length,
    avgRequests: avg("requests"),
    avgTokens: avg("totalTokens"),
    avgDuration: activeTimePeople.length ? totalActiveTime / activeTimePeople.length : 0,
    avgActiveDays: avg("activeDays"),
    avgSuccessRate: avg("successRate"),
  };
}

export function buildPersonUsageAnalysisFromStats(stats) {
  const people = Object.entries(stats?.byUser || {}).map(([key, item]) => ({
    key,
    ...item,
    totalTokens: (item.promptTokens || 0) + (item.completionTokens || 0),
  }));
  const totals = {
    totalRequests: stats?.totalRequests || 0,
    totalTokens: (stats?.totalPromptTokens || 0) + (stats?.totalCompletionTokens || 0),
    totalCost: stats?.totalCost || 0,
  };
  return buildPersonUsageAnalysis(people, totals);
}
