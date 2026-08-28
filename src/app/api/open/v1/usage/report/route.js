import { NextResponse } from "next/server";
import { getApiKeyById } from "@/lib/localDb";
import { getUsageStats } from "@/lib/usageDb";
import { authenticateOpenPlatformRequest } from "@/lib/openPlatform/auth";
import { recordOpenPlatformRequest } from "@/lib/openPlatform/callLogging";
import { buildPersonUsageAnalysisFromStats } from "@/shared/utils/personUsageAnalysis";

const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" };
const MAX_DATE_LENGTH = 64;
const PERIOD_LABELS = ["00:00–03:59", "04:00–07:59", "08:00–11:59", "12:00–15:59", "16:00–19:59", "20:00–23:59"];
const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

export const dynamic = "force-dynamic";

function errorResponse(status, code, message) {
  return NextResponse.json({ error: { code, message } }, { status, headers: NO_STORE_HEADERS });
}

function parseDateRange(searchParams) {
  const startDate = searchParams.get("startDate");
  const endDate = searchParams.get("endDate");
  if (!startDate || !endDate || startDate.length > MAX_DATE_LENGTH || endDate.length > MAX_DATE_LENGTH) return null;

  const startMs = Date.parse(startDate);
  const endMs = Date.parse(endDate);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) return null;

  return {
    startDate: new Date(startMs).toISOString(),
    endDate: new Date(endMs).toISOString(),
  };
}

function serializeBreakdown(entries = {}) {
  return Object.entries(entries)
    .map(([name, item]) => ({
      name,
      requests: item?.requests || 0,
      promptTokens: item?.promptTokens || 0,
      completionTokens: item?.completionTokens || 0,
      cachedTokens: item?.cachedTokens || 0,
      totalTokens: (item?.promptTokens || 0) + (item?.completionTokens || 0),
      estimatedCost: item?.cost || 0,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests);
}

function serializeRhythm(values = [], labels) {
  return labels.map((label, index) => ({ label, requests: values[index] || 0 }));
}

function emptyUsage() {
  return {
    requests: 0,
    completedRequests: 0,
    failedRequests: 0,
    cancelledRequests: 0,
    successRate: 0,
    tokensPerRequest: 0,
    tokens: { prompt: 0, completion: 0, cached: 0, total: 0 },
    estimatedCost: 0,
    duration: {
      requestTotalMs: 0,
      requestAverageMs: 0,
      activeSessionMs: 0,
      effectiveActiveMs: 0,
      coveredRequests: 0,
    },
    activity: {
      activeDays: 0,
      sessionCount: 0,
      firstUsedAt: null,
      lastUsedAt: null,
      periods: serializeRhythm([], PERIOD_LABELS),
      weekdays: serializeRhythm([], WEEKDAY_LABELS),
    },
    modelCount: 0,
    models: [],
    applications: [],
    sourceIps: [],
  };
}

function serializeUsage(person) {
  if (!person) return emptyUsage();
  return {
    requests: person.requests || 0,
    completedRequests: person.completedRequests || 0,
    failedRequests: person.failedRequests || 0,
    cancelledRequests: person.cancelledRequests || 0,
    successRate: person.successRate || 0,
    tokensPerRequest: person.tokensPerRequest || 0,
    tokens: {
      prompt: person.promptTokens || 0,
      completion: person.completionTokens || 0,
      cached: person.cachedTokens || 0,
      total: person.totalTokens || 0,
    },
    estimatedCost: person.cost || 0,
    duration: {
      requestTotalMs: person.requestDurationMs || 0,
      requestAverageMs: person.averageRequestDurationMs || 0,
      activeSessionMs: person.activeSessionDurationMs || 0,
      effectiveActiveMs: person.effectiveDurationMs || 0,
      coveredRequests: person.durationRequestCount || 0,
    },
    activity: {
      activeDays: person.activeDays || 0,
      sessionCount: person.sessionCount || 0,
      firstUsedAt: person.firstUsed || null,
      lastUsedAt: person.lastUsed || null,
      periods: serializeRhythm(person.periods, PERIOD_LABELS),
      weekdays: serializeRhythm(person.weekdays, WEEKDAY_LABELS),
    },
    modelCount: person.modelCount || 0,
    models: serializeBreakdown(person.models),
    applications: serializeBreakdown(person.apps),
    sourceIps: serializeBreakdown(person.sourceIps),
  };
}

function serializeComparison(analysis, person) {
  const base = {
    activeMemberCount: analysis.rows.length,
    teamAverages: {
      requests: analysis.avgRequests,
      totalTokens: analysis.avgTokens,
      effectiveActiveMs: analysis.avgDuration,
      activeDays: analysis.avgActiveDays,
      successRate: analysis.avgSuccessRate,
    },
    tierDistribution: {
      high: analysis.highCount,
      medium: analysis.mediumCount,
      low: analysis.lowCount,
    },
    benchmarks: analysis.benchmarks,
  };

  if (!person) {
    return {
      ...base,
      referenceScore: null,
      tier: null,
      percentile: null,
      ranks: { overall: null, tokens: null, requests: null, effectiveActive: null, successRate: null },
    };
  }

  return {
    ...base,
    referenceScore: person.referenceScore,
    tier: { id: person.tier.id, label: person.tier.label },
    percentile: person.percentile,
    ranks: {
      overall: person.rank,
      tokens: person.tokenRank,
      requests: person.requestRank,
      effectiveActive: person.durationRank,
      successRate: person.successRank,
    },
  };
}

export async function GET(request) {
  const startedAt = Date.now();
  let credential = null;
  let subjectUserId = null;
  const finish = (response) => recordOpenPlatformRequest({ credential, request, response, startedAt, subjectUserId });

  try {
    const auth = await authenticateOpenPlatformRequest(request);
    if (auth.error === "missing_api_key") {
      return errorResponse(401, "missing_api_key", "Provide an open platform API key with Authorization: Bearer <key> or x-api-key.");
    }
    if (auth.error) return errorResponse(401, "invalid_api_key", "The open platform API key is invalid or disabled.");
    credential = auth.credential;

    const searchParams = new URL(request.url).searchParams;
    const userId = searchParams.get("userId");
    if (!userId || userId.length > 128) {
      return await finish(errorResponse(400, "invalid_user_id", "userId is required."));
    }
    subjectUserId = userId;
    const apiKey = await getApiKeyById(userId);
    if (!apiKey) return await finish(errorResponse(404, "user_not_found", "The requested user does not exist."));

    const range = parseDateRange(searchParams);
    if (!range) {
      return await finish(errorResponse(400, "invalid_date_range", "startDate and endDate are required ISO-8601 dates, and startDate must not be after endDate."));
    }

    const stats = await getUsageStats("all", range);
    const analysis = buildPersonUsageAnalysisFromStats(stats);
    const person = analysis.rows.find((row) => row.key === apiKey.id) || null;

    const response = NextResponse.json({
      object: "usage_report",
      generatedAt: new Date().toISOString(),
      range,
      subject: {
        userId: apiKey.id,
        name: apiKey.name || "Unnamed API key",
        hasUsage: Boolean(person),
      },
      usage: serializeUsage(person),
      comparison: serializeComparison(analysis, person),
      notice: "AI usage metrics are reference data and should not be treated as business output or final performance evaluation on their own.",
    }, { headers: NO_STORE_HEADERS });
    return await finish(response);
  } catch (error) {
    console.error("[API] Failed to build external usage report:", error);
    return await finish(errorResponse(500, "usage_report_failed", "Failed to build usage report."));
  }
}
