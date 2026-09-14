/**
 * Daily time windows, shared by combo model scheduling and account scheduling.
 *
 * Deliberately pure: no imports, no ambient state. Lives here (next to
 * accessTags.js) because both sides need the identical rules — the request path
 * in open-sse and the dashboard — and a second copy of these comparisons is
 * exactly how one surface starts disagreeing with the other about whether a
 * window is open.
 *
 * Shape (both callers store it verbatim in JSON):
 *   { timezone?, active: [{start,end}], inactive: [{start,end}],
 *     activeEnabled, inactiveEnabled }
 * Times are "HH:MM" and windows may cross midnight (22:00-06:00).
 */

const TIME_OF_DAY_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "HH:MM" -> minutes since local midnight, or null when unusable. */
export function parseTimeOfDay(value) {
  const match = TIME_OF_DAY_REGEX.exec(String(value ?? ""));
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function isTimeOfDayString(value) {
  return TIME_OF_DAY_REGEX.test(String(value ?? ""));
}

/**
 * Validate a window list. Returns the deduplicated list, or null when any entry
 * is unusable. Null must be read as "reject", never as "no windows".
 */
export function normalizeTimeWindows(windows) {
  if (!Array.isArray(windows)) return null;

  const normalized = [];
  const seen = new Set();
  for (const window of windows) {
    if (!window || typeof window !== "object" || Array.isArray(window)) return null;
    const start = String(window.start ?? "").trim();
    const end = String(window.end ?? "").trim();
    if (!TIME_OF_DAY_REGEX.test(start) || !TIME_OF_DAY_REGEX.test(end) || start === end) return null;
    const key = `${start}-${end}`;
    if (seen.has(key)) return null;
    seen.add(key);
    normalized.push({ start, end });
  }
  return normalized;
}

/** Canonical schedule for storage; null means "malformed, reject". */
export function normalizeScheduleForStorage(schedule) {
  if (schedule == null) return null;
  if (typeof schedule !== "object" || Array.isArray(schedule)) return null;

  const timezone = String(schedule.timezone || "").trim();
  if (timezone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
      return null;
    }
  }

  // Legacy flat shape: { start, end }. Canonicalize it to one active window.
  const hasLegacyPair = schedule.start !== undefined || schedule.end !== undefined;
  const legacyActive = hasLegacyPair
    ? normalizeTimeWindows([{ start: schedule.start, end: schedule.end }])
    : null;
  if (hasLegacyPair) {
    if (!legacyActive) return null;
  } else if (!Array.isArray(schedule.active) && !Array.isArray(schedule.inactive)) {
    return null;
  }

  const active = legacyActive || normalizeTimeWindows(schedule.active || []);
  const inactive = normalizeTimeWindows(schedule.inactive || []);
  if (!active || !inactive) return null;

  return {
    ...(timezone ? { timezone } : {}),
    active,
    inactive,
    activeEnabled: schedule.activeEnabled !== false,
    inactiveEnabled: schedule.inactiveEnabled === true
      || (schedule.inactiveEnabled === undefined && inactive.length > 0),
  };
}

/**
 * Windows for one field, tolerating the legacy flat { start, end } shape on
 * `active`. Unreadable input yields [] so callers never crash on old rows.
 */
export function getEffectiveScheduleWindows(schedule, field) {
  if (!schedule || typeof schedule !== "object") return [];
  const stored = schedule[field];
  if (Array.isArray(stored)) return stored;
  if (field === "active" && (schedule.start !== undefined || schedule.end !== undefined)) {
    return [{ start: schedule.start, end: schedule.end }];
  }
  return [];
}

/** Minutes since local midnight in `timezone`, or null when unreadable. */
export function localMinuteOfDay(timezone, now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || undefined,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return ((hour % 24) * 60) + minute;
  } catch {
    return null;
  }
}

export function isInDailyWindow(current, window) {
  const start = parseTimeOfDay(window?.start);
  const end = parseTimeOfDay(window?.end);
  if (start === null || end === null) return false;

  // Equal boundaries mean the full day. Windows may also cross midnight, which
  // is why the comparison is not a plain between.
  if (start === end) return true;
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
}

/**
 * Is `schedule` open at `now`?
 *
 * No schedule means all day, matching how an unconfigured combo node behaves.
 * `onInvalid` decides what an unusable schedule costs the caller, because the
 * two callers are wrong in opposite directions: a combo fails closed (the model
 * list is a permission boundary, so admitting an unschedulable model is worse),
 * while account routing fails open (silently dropping a healthy account out of
 * rotation is worse than honouring a window we could not parse).
 */
export function isScheduleActive(schedule, now = new Date(), { onInvalid = false } = {}) {
  if (!schedule || typeof schedule !== "object") return true;

  const current = localMinuteOfDay(schedule.timezone, now);
  if (current === null) return onInvalid;

  const active = schedule.activeEnabled === false ? [] : getEffectiveScheduleWindows(schedule, "active");
  const inactive = schedule.inactiveEnabled === false ? [] : getEffectiveScheduleWindows(schedule, "inactive");
  // Empty active means all day. Inactive always wins over active.
  const activeMatch = active.length === 0 || active.some((window) => isInDailyWindow(current, window));
  const inactiveMatch = inactive.some((window) => isInDailyWindow(current, window));
  return activeMatch && !inactiveMatch;
}

/** Compact one-line rendering for routing logs. */
export function describeSchedule(schedule) {
  if (!schedule || typeof schedule !== "object") return "全天";
  const active = getEffectiveScheduleWindows(schedule, "active");
  const inactive = getEffectiveScheduleWindows(schedule, "inactive");
  const parts = [];
  if (schedule.activeEnabled === false) {
    parts.push("未启用时段");
  } else {
    parts.push(active.length === 0 ? "全天" : active.map((w) => `${w?.start}-${w?.end}`).join(","));
  }
  if (schedule.inactiveEnabled !== false && inactive.length > 0) {
    parts.push(`除 ${inactive.map((w) => `${w?.start}-${w?.end}`).join(",")}`);
  }
  if (schedule.timezone) parts.push(schedule.timezone);
  return parts.join(" · ");
}

/** A window the editor should flag: incomplete, or zero length. */
export function isTimeWindowInvalid(window) {
  return !window?.start || !window?.end || window.start === window.end;
}

/** A field the editor should flag: any bad window, or a repeated window. */
export function isScheduleFieldInvalid(schedule, field) {
  const windows = getEffectiveScheduleWindows(schedule, field);
  if (windows.some(isTimeWindowInvalid)) return true;
  const keys = new Set();
  for (const window of windows) {
    const key = `${window.start}-${window.end}`;
    if (keys.has(key)) return true;
    keys.add(key);
  }
  return false;
}

/** Which field blocks saving, or null when the schedule is safe to submit. */
export function findInvalidScheduleField(schedule) {
  if (!schedule || typeof schedule !== "object") return null;
  return ["active", "inactive"].find((field) => isScheduleFieldInvalid(schedule, field)) || null;
}

export function scheduleFieldLabel(field) {
  return field === "active" ? "生效" : "失效";
}
