// 关键验证：datetime.js 在「浏览器时区 ≠ 东八区」时，是否仍输出东八区？
// 这是修复的核心价值 —— 之前跟随浏览器，现在固定 APP_TIMEZONE。
// 注意：Intl 的 timeZone 选项不受 process.env.TZ 影响（它是显式指定的），
// 所以这个测试恰好证明「即使宿主在 UTC，输出仍是 CST」。
import { describe, it, expect } from "vitest";
import {
  APP_TIMEZONE, formatDateTime, formatDate, formatTime,
  startOfDay, endOfDay, toDateInputValue,
} from "@/shared/utils/datetime.js";

describe("datetime is independent of the host/browser timezone", () => {
  it("pins to Asia/Shanghai regardless of process.env.TZ", () => {
    expect(APP_TIMEZONE).toBe("Asia/Shanghai");
  });

  it("renders UTC input as CST even though the process may be UTC", () => {
    // 10:25 UTC === 18:25 CST. If this followed the process/browser zone, a UTC
    // host would render 10:25 — the bug this module exists to prevent.
    expect(formatDateTime("2026-09-25T10:25:10Z")).toBe("2026/09/25 18:25:10");
    expect(formatTime("2026-09-25T10:25:10Z")).toBe("18:25:10");
    // 15:59:59Z is still the 25th in CST; 16:00:00Z becomes the 26th.
    expect(formatDate("2026-09-25T15:59:59Z")).toBe("2026/09/25");
    expect(formatDate("2026-09-25T16:00:00Z")).toBe("2026/09/26");
  });

  it("day boundaries are CST midnights, not the host's", () => {
    const noon = new Date("2026-09-25T10:25:10Z");
    expect(startOfDay(noon).toISOString()).toBe("2026-09-24T16:00:00.000Z");
    expect(endOfDay(noon).toISOString()).toBe("2026-09-25T15:59:59.999Z");
    expect(toDateInputValue(noon)).toBe("2026-09-25");
  });

  it("a range built by the client matches what the server gate accepts", async () => {
    // End-to-end: the range the dashboard sends must satisfy the server's
    // day-alignment gate, which uses the same APP_TIMEZONE basis.
    const { realtimeRange } = await import("@/shared/utils/realtimeRange.js");
    const { isDayAlignedRange } = await import("../../runtime/usage-rollup-read.mjs");
    const range = realtimeRange("7d", new Date("2026-09-25T10:25:10Z"));
    expect(isDayAlignedRange(range)).toBe(true);
    // Whole CST days: start is a CST midnight, end a CST end-of-day.
    expect(new Date(range.startDate).toISOString().slice(11)).toBe("16:00:00.000Z");
  });
});
