import { beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeConnectionError, formatConnectionErrorDetails, getConnectionErrorEvidence } from "../../src/shared/utils/connectionErrorEvidence.js";
import { parseUpstreamError } from "../../open-sse/utils/error.js";

const db = vi.hoisted(() => ({ updateProviderConnectionHealth: vi.fn() }));
vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn() }));
vi.mock("@/shared/constants/providers.js", () => ({ FREE_PROVIDERS: {}, resolveProviderId: (p) => p }));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));
const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");
let account;
beforeEach(() => {
  account = { id: "fixture", provider: "qoder", name: "模拟账号", testStatus: "active" };
  db.updateProviderConnectionHealth.mockImplementation(async (_id, update) => {
    const result = update(account);
    Object.assign(account, result?.update);
    return result?.value;
  });
});

describe("channel failure analysis and full error copying", () => {
  it.each([400, 429, 503])("preserves the actual response through parsing, storage and copy for HTTP %s", async (status) => {
    const raw = JSON.stringify({ error: { message: "Upstream failure", detail: "x".repeat(9000) }, request_id: "original-request-at-tail" }, null, 2);
    const parsed = await parseUpstreamError(new Response(raw, { status }));
    const decision = await markAccountUnavailable(account.id, status, parsed.message, account.provider, "fixture-model", null, parsed.upstreamError);
    expect(parsed.upstreamError.body).toBe(raw);
    expect(account.lastUpstreamRaw).toBe(raw);
    const evidence = getConnectionErrorEvidence(account);
    const copied = formatConnectionErrorDetails(account, evidence);
    expect(copied).toContain(raw);
    expect(copied).toContain("original-request-at-tail");
    expect(copied).toContain("失败原因分析");
    if (status === 400) {
      expect(decision.shouldFallback).toBe(false);
      expect(account.testStatus).toBe("active");
      expect(account).not.toHaveProperty("errorCode");
    }
  });

  it("selects the newest failure, retaining gateway context without inventing an upstream response", () => {
    const evidence = getConnectionErrorEvidence({ lastUpstreamError: "old", lastUpstreamAt: "2026-11-01", gatewayError: "fetch failed", gatewayErrorAt: "2026-11-02", gatewayErrorCode: 502 });
    expect(evidence.kind).toBe("gateway");
    expect(analyzeConnectionError(evidence).reason).toBe("网关或网络链路失败");
    expect(formatConnectionErrorDetails(account, evidence)).toContain("未记录原始上游报文");
  });

  it("does not conflate generic throttling, capacity and quota errors", () => {
    const evidence = { kind: "upstream", layer: "provider", status: 429, text: "Too many requests" };
    expect(analyzeConnectionError(evidence).reason).toBe("上游限流或用量限制");
    expect(analyzeConnectionError({ ...evidence, raw: '{"error":{"code":"insufficient_quota"}}' }).reason).toBe("上游额度或余额限制");
    expect(analyzeConnectionError({ ...evidence, text: "上游模型资源受限 / 排队" }).reason).toBe("上游资源繁忙或排队");
  });

  it("attributes a nested Qoder queue response carried in an HTTP 200 SSE frame", () => {
    const details = { isQueued: true, modelKey: "dfmodel", queueCount: 0, queueType: "p3", retryAfterSeconds: 30, serviceAvailable: false, subCode: "RESOURCE_LIMIT", waitTime: 30 };
    const inner = { code: "10605", message: JSON.stringify(details), subCode: "RESOURCE_LIMIT" };
    const connection = { provider: "qoder", name: "模拟账号", lastUpstreamError: JSON.stringify(inner), lastUpstreamRaw: JSON.stringify({ code: "403", message: JSON.stringify(inner) }), lastUpstreamSource: "sse", lastUpstreamStatus: 200 };
    const evidence = getConnectionErrorEvidence(connection);
    for (const provider of ["qoder", "qoder-cn"]) {
      const analysis = analyzeConnectionError(evidence, provider);
      expect(analysis.reason).toBe("上游模型资源受限或排队");
      expect(analysis.basis).toContain("30 秒");
      expect(analysis.basis).toContain("不代表积分不足或账号失效");
      expect(analysis.suggestion).toContain("30 秒");
    }
    const copied = formatConnectionErrorDetails(connection, evidence);
    expect(copied).toContain("上游模型资源受限或排队");
    expect(copied).not.toContain("暂无法确定具体失败原因");
    expect(copied).toContain(connection.lastUpstreamRaw);
    // Without the provider the keyword fallback still avoids "unknown", and the wrapper's "403" string is not a status.
    expect(analyzeConnectionError(evidence).reason).toBe("上游资源繁忙或排队");
    expect(analyzeConnectionError(evidence, "workbuddy").reason).toBe("上游资源繁忙或排队");
    expect(analyzeConnectionError({ ...evidence, text: '{"code":"112"}', raw: null }, "qoder").reason).toBe("上游额度或余额限制");
    expect(analyzeConnectionError({ ...evidence, kind: "gateway", layer: "gateway" }, "qoder").reason).toBe("网关或网络链路失败");
  });

  it("copies raw-only evidence and labels SSE transport status honestly", () => {
    const evidence = getConnectionErrorEvidence({ lastUpstreamRaw: '{"code":112,"message":"quota exceeded"}', lastUpstreamSource: "sse", lastUpstreamStatus: 200 });
    expect(evidence).not.toBeNull();
    expect(formatConnectionErrorDetails(account, evidence)).toContain("SSE 传输状态");
    expect(formatConnectionErrorDetails(account, evidence)).toContain(evidence.raw);
  });
});
