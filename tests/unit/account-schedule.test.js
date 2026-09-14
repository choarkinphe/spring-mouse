import { describe, it, expect } from "vitest";
import {
  isScheduleActive,
  normalizeScheduleForStorage,
  describeSchedule,
  findInvalidScheduleField,
  getEffectiveScheduleWindows,
} from "../../src/shared/utils/schedule.js";

/**
 * Asia/Shanghai is UTC+8 with no DST, so a local wall-clock time maps to exactly
 * one instant and the expectations below stay readable.
 */
function shanghai(hour, minute = 0, day = 14) {
  return new Date(Date.UTC(2026, 8, day, hour - 8, minute, 0));
}

const window = (start, end) => ({ start, end });

describe("account enable window", () => {
  it("leaves an account with no window available all day", () => {
    expect(isScheduleActive(undefined, shanghai(3))).toBe(true);
    expect(isScheduleActive(null, shanghai(3))).toBe(true);
    expect(isScheduleActive({}, shanghai(3))).toBe(true);
  });

  it("treats an empty active list as all day", () => {
    const schedule = { active: [], inactive: [], activeEnabled: true, inactiveEnabled: false };
    expect(isScheduleActive(schedule, shanghai(3))).toBe(true);
  });

  it("is half-open on the closing boundary", () => {
    const schedule = { timezone: "Asia/Shanghai", active: [window("09:00", "22:30")] };
    expect(isScheduleActive(schedule, shanghai(8, 59))).toBe(false);
    expect(isScheduleActive(schedule, shanghai(9))).toBe(true);
    expect(isScheduleActive(schedule, shanghai(22, 29))).toBe(true);
    expect(isScheduleActive(schedule, shanghai(22, 30))).toBe(false);
  });

  it("supports windows that cross midnight", () => {
    const schedule = { timezone: "Asia/Shanghai", active: [window("22:00", "06:00")] };
    expect(isScheduleActive(schedule, shanghai(23, 30))).toBe(true);
    expect(isScheduleActive(schedule, shanghai(2))).toBe(true);
    expect(isScheduleActive(schedule, shanghai(6))).toBe(false);
    expect(isScheduleActive(schedule, shanghai(12))).toBe(false);
  });

  it("lets an inactive window win over an active one", () => {
    const schedule = {
      timezone: "Asia/Shanghai",
      active: [],
      inactive: [window("12:00", "13:00")],
      inactiveEnabled: true,
    };
    expect(isScheduleActive(schedule, shanghai(11, 59))).toBe(true);
    expect(isScheduleActive(schedule, shanghai(12, 30))).toBe(false);
  });

  it("ignores a disabled field", () => {
    const disabledActive = {
      timezone: "Asia/Shanghai",
      active: [window("09:00", "10:00")],
      activeEnabled: false,
    };
    expect(isScheduleActive(disabledActive, shanghai(3))).toBe(true);

    const disabledInactive = {
      timezone: "Asia/Shanghai",
      inactive: [window("00:00", "23:00")],
      inactiveEnabled: false,
    };
    expect(isScheduleActive(disabledInactive, shanghai(3))).toBe(true);
  });

  it("evaluates the window in the schedule timezone, not the host's", () => {
    const at = shanghai(22);
    const inShanghai = { timezone: "Asia/Shanghai", active: [window("22:00", "22:30")] };
    const inTokyo = { timezone: "Asia/Tokyo", active: [window("22:00", "22:30")] };
    expect(isScheduleActive(inShanghai, at)).toBe(true);
    expect(isScheduleActive(inTokyo, at)).toBe(false);
  });

  it("fails open for account routing but closed for combo models", () => {
    const unreadable = { timezone: "Not/AZone", active: [window("09:00", "10:00")] };
    expect(isScheduleActive(unreadable, shanghai(3), { onInvalid: true })).toBe(true);
    expect(isScheduleActive(unreadable, shanghai(3))).toBe(false);
  });
});

describe("schedule storage normalization", () => {
  it("accepts a well-formed schedule", () => {
    const normalized = normalizeScheduleForStorage({ active: [window("09:00", "18:00")] });
    expect(normalized.active).toEqual([window("09:00", "18:00")]);
    expect(normalized.inactive).toEqual([]);
  });

  it("rejects zero-length, duplicated, and malformed windows", () => {
    expect(normalizeScheduleForStorage({ active: [window("09:00", "09:00")] })).toBeNull();
    expect(normalizeScheduleForStorage({
      active: [window("09:00", "18:00"), window("09:00", "18:00")],
    })).toBeNull();
    expect(normalizeScheduleForStorage({ active: [window("9:00", "18:00")] })).toBeNull();
    expect(normalizeScheduleForStorage({ timezone: "Nope/Nope", active: [] })).toBeNull();
  });

  it("canonicalizes the legacy flat shape", () => {
    const normalized = normalizeScheduleForStorage({ start: "09:00", end: "18:00" });
    expect(getEffectiveScheduleWindows(normalized, "active")).toEqual([window("09:00", "18:00")]);
  });
});

describe("schedule editor validation", () => {
  it("passes a clean schedule", () => {
    expect(findInvalidScheduleField({ active: [], inactive: [] })).toBeNull();
    expect(findInvalidScheduleField({ active: [window("09:00", "18:00")] })).toBeNull();
  });

  it("names the field that blocks saving", () => {
    expect(findInvalidScheduleField({ active: [window("09:00", "09:00")] })).toBe("active");
    expect(findInvalidScheduleField({ inactive: [window("01:00", "01:00")] })).toBe("inactive");
  });

  it("renders a compact label for routing logs", () => {
    expect(describeSchedule(undefined)).toBe("全天");
    expect(describeSchedule({ active: [window("09:00", "18:00")], timezone: "Asia/Shanghai" }))
      .toBe("09:00-18:00 · Asia/Shanghai");
    expect(describeSchedule({
      active: [],
      inactive: [window("12:00", "13:00")],
      inactiveEnabled: true,
      timezone: "Asia/Shanghai",
    })).toBe("全天 · 除 12:00-13:00 · Asia/Shanghai");
  });
});
