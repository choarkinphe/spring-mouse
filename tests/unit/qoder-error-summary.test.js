import { describe, it, expect } from "vitest";
import { summarizeQoderError } from "../../src/shared/utils/qoderErrorSummary.js";
import { currentDailyCheckinState } from "../../src/shared/config/codebuddyCheckin.js";

describe("Qoder error explanation", () => {
  const details = { retryAfterSeconds: 30, serviceAvailable: false, subCode: "RESOURCE_LIMIT" };
  const inner = { code: "10605", message: JSON.stringify(details) };
  const evidence = { kind: "upstream", text: JSON.stringify(inner), raw: JSON.stringify({ code: "403", message: JSON.stringify(inner) }) };
  it.each(["qoder", "qoder-cn"])("summarizes nested resource failures for %s", provider => {
    const summary = summarizeQoderError(provider, evidence);
    expect(summary).toContain("资源受限／排队");
    expect(summary).toContain("30 秒");
    expect(summary).toContain("不代表积分不足");
  });
  it("distinguishes 112 and does not reinterpret unrelated or gateway failures", () => {
    expect(summarizeQoderError("qoder", { kind: "upstream", text: '{"code":"112"}' })).toContain("上游额度限制");
    expect(summarizeQoderError("workbuddy", evidence)).toBeNull();
    expect(summarizeQoderError("qoder", { ...evidence, kind: "gateway" })).toBeNull();
    expect(summarizeQoderError("qoder", { kind: "upstream", text: "bad json" })).toBeNull();
  });
});

describe("obsolete Qoder precheck", () => {
  const old = { enabled: true, status: "own_app", message: "Qoder 国际版签到需要官方设备身份，请在当前主机安装并登录 Qoder 官方客户端或 CLI，或在官方客户端签到", terminalDate: "2026-11-04", lastAttemptAt: "2026-11-04T05:06:00Z", leaseId: "preserve", lastSuccessDate: "2026-11-03" };
  it("expires only obsolete local failure without erasing claims or leases", () => {
    expect(currentDailyCheckinState(old, "qoder")).toMatchObject({ status: "recheck", terminalDate: null, retryAfter: 0, enabled: true, leaseId: "preserve", lastSuccessDate: "2026-11-03", lastAttemptAt: null });
    expect(currentDailyCheckinState(old, "qoder-cn")).toBe(old);
    const official = { ...old, message: "Qoder 官方未向当前请求提供可领取积分活动" };
    expect(currentDailyCheckinState(official, "qoder")).toBe(official);
    const success = { ...old, status: "success" };
    expect(currentDailyCheckinState(success, "qoder")).toBe(success);
  });
});
