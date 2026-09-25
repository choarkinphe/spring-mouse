import { describe, it, expect } from "vitest";
import {
  APP_TIMEZONE, formatDateTime, formatDate, formatTime, formatShortDateTime, formatMonthDay,
  startOfDay, endOfDay, startOfWeek, startOfMonth, startOfNextMonth,
  toDateInputValue, toDatetimeLocalValue, formatChineseDate,
} from "@/shared/utils/datetime.js";

describe("datetime timezone helpers (Asia/Shanghai)", () => {
  it("defaults to Asia/Shanghai", () => {
    expect(APP_TIMEZONE).toBe("Asia/Shanghai");
  });

  it("renders a UTC instant in CST (+8)", () => {
    // 2026-09-24T16:32:23Z === 2026-09-25 00:32:23 CST
    expect(formatDateTime("2026-09-24T16:32:23Z")).toBe("2026/09/25 00:32:23");
    expect(formatDate("2026-09-24T16:32:23Z")).toBe("2026/09/25");
    expect(formatTime("2026-09-24T16:32:23Z")).toBe("00:32:23");
  });

  it("crosses the date boundary correctly", () => {
    // 15:59:59Z is still 23:59:59 CST on the SAME day
    expect(formatDateTime("2026-09-24T15:59:59Z")).toBe("2026/09/24 23:59:59");
    // 16:00:00Z is 00:00:00 CST the NEXT day
    expect(formatDateTime("2026-09-24T16:00:00Z")).toBe("2026/09/25 00:00:00");
  });

  it("startOfDay is CST midnight (16:00Z previous day)", () => {
    const d = startOfDay(new Date("2026-09-25T09:05:00Z")); // 17:05 CST
    expect(d.toISOString()).toBe("2026-09-24T16:00:00.000Z");
  });

  it("endOfDay is CST 23:59:59.999", () => {
    const d = endOfDay(new Date("2026-09-25T09:05:00Z"));
    expect(d.toISOString()).toBe("2026-09-25T15:59:59.999Z");
  });

  it("startOfWeek is the Monday of that CST week", () => {
    // 2026-09-25 is a Friday (CST) -> Monday is 2026-09-21 (CST)
    const d = startOfWeek(new Date("2026-09-25T09:05:00Z"));
    expect(d.toISOString()).toBe("2026-09-20T16:00:00.000Z"); // 2026-09-21 00:00 CST
  });

  it("startOfMonth / startOfNextMonth are CST month bounds", () => {
    const anchor = new Date("2026-09-25T09:05:00Z");
    expect(startOfMonth(anchor).toISOString()).toBe("2026-08-31T16:00:00.000Z"); // 09-01 00:00 CST
    expect(startOfNextMonth(anchor).toISOString()).toBe("2026-09-30T16:00:00.000Z"); // 10-01 00:00 CST
  });

  it("handles a near-midnight instant without drifting a day", () => {
    // 2026-09-24T16:00:00Z is exactly CST midnight of the 25th
    const d = startOfDay(new Date("2026-09-24T16:00:00Z"));
    expect(d.toISOString()).toBe("2026-09-24T16:00:00.000Z");
    expect(formatDate(d)).toBe("2026/09/25");
  });

  it("input values use CST wall clock", () => {
    expect(toDateInputValue(new Date("2026-09-24T16:32:23Z"))).toBe("2026-09-25");
    expect(toDatetimeLocalValue("2026-09-24T16:32:23Z")).toBe("2026-09-25T00:32");
  });

  it("Chinese date and invalid input", () => {
    expect(formatChineseDate("2026-09-24T16:32:23Z")).toBe("2026年09月25日");
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime("not-a-date")).toBe("—");
  });
});
