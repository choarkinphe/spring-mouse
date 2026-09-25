/**
 * Single source of truth for how the dashboard renders and buckets time.
 *
 * Everything the dashboard shows is pinned to ONE timezone rather than the
 * browser's. The reason is correctness, not preference: the server buckets usage
 * by its own local day (the container runs with TZ=Asia/Shanghai), so a browser in
 * another timezone would show a "today" whose boundaries disagree with the data it
 * is displaying — the range would silently include or exclude hours.
 *
 * Pinning the display to the same zone keeps the numbers and the labels agreeing.
 * Override with NEXT_PUBLIC_APP_TIMEZONE if the deployment is not in CST.
 *
 * Every function takes the value first and options last so call sites read the
 * same way whether they want a date, a time, or both.
 */

export const APP_TIMEZONE =
  (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_APP_TIMEZONE) || "Asia/Shanghai";

const DATE_TIME = {
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hour12: false,
};
const DATE_ONLY = { year: "numeric", month: "2-digit", day: "2-digit" };
const SHORT_DATE_TIME = { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false };
const MONTH_DAY = { month: "2-digit", day: "2-digit" };
const TIME_ONLY = { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false };

function toDate(value) {
  if (value == null || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function fmt(value, options, locale = "zh-CN") {
  const date = toDate(value);
  if (!date) return "—";
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: APP_TIMEZONE }).format(date);
}

/** "2026-09-25 17:03:37" (CST) — the default full timestamp. */
export function formatDateTime(value, locale) {
  return fmt(value, DATE_TIME, locale);
}

/** "2026-09-25" (CST). */
export function formatDate(value, locale) {
  return fmt(value, DATE_ONLY, locale);
}

/** "17:03:37" (CST). */
export function formatTime(value, locale) {
  return fmt(value, TIME_ONLY, locale);
}

/** "09-25 17:03" (CST) — compact, for dense tables. */
export function formatShortDateTime(value, locale) {
  return fmt(value, SHORT_DATE_TIME, locale);
}

/** "09-25" (CST) — date only, no year, for dense tables. */
export function formatMonthDay(value, locale) {
  return fmt(value, MONTH_DAY, locale);
}

// ---------------------------------------------------------------------------
// Timezone-aware day boundaries.
//
// `setHours(0,0,0,0)` uses the BROWSER's midnight. The server uses its own local
// midnight to cut days, so a browser elsewhere would request the wrong range.
// These compute the instant that is midnight in APP_TIMEZONE instead.
// ---------------------------------------------------------------------------

/** Offset of `timeZone` at `date`, in minutes east of UTC. */
function tzOffsetMinutes(date, timeZone = APP_TIMEZONE) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(date).map((p) => [p.type, p.value])
  );
  const asUTC = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)
  );
  return (asUTC - date.getTime()) / 60000;
}

/** The wall-clock {year, month, day} of `date` in `timeZone`. */
function wallClock(date, timeZone = APP_TIMEZONE) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(date).map((p) => [p.type, p.value])
  );
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

/** The instant of `y-m-d 00:00:00` in `timeZone`. */
function instantOfMidnight(y, m, d, timeZone = APP_TIMEZONE) {
  // Start from the naive UTC guess, then correct by the zone's offset. A second
  // pass settles it (exact for zones without DST, and correct at the boundary
  // for those with it).
  let ms = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  for (let i = 0; i < 2; i++) {
    ms = Date.UTC(y, m - 1, d, 0, 0, 0, 0) - tzOffsetMinutes(new Date(ms), timeZone) * 60000;
  }
  return new Date(ms);
}

/** Midnight at the start of `date`'s day, in APP_TIMEZONE. */
export function startOfDay(value = new Date(), timeZone = APP_TIMEZONE) {
  const date = toDate(value) || new Date();
  const { year, month, day } = wallClock(date, timeZone);
  return instantOfMidnight(year, month, day, timeZone);
}

/** The last millisecond of `date`'s day, in APP_TIMEZONE. */
export function endOfDay(value = new Date(), timeZone = APP_TIMEZONE) {
  const next = startOfDay(value, timeZone);
  // +24h then -1ms lands on the same wall-clock day's end for fixed-offset zones.
  return new Date(next.getTime() + 24 * 3600_000 - 1);
}

/** Midnight on the Monday of `date`'s week, in APP_TIMEZONE. */
export function startOfWeek(value = new Date(), timeZone = APP_TIMEZONE) {
  const start = startOfDay(value, timeZone);
  const { year, month, day } = wallClock(start, timeZone);
  // Weekday of that wall-clock date, computed in UTC so it is timezone-stable.
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0=Sun
  const offset = (weekday + 6) % 7; // days since Monday
  const shifted = new Date(Date.UTC(year, month - 1, day - offset));
  return instantOfMidnight(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate(), timeZone);
}

/** Midnight on the 1st of `date`'s month, in APP_TIMEZONE. */
export function startOfMonth(value = new Date(), timeZone = APP_TIMEZONE) {
  const { year, month } = wallClock(toDate(value) || new Date(), timeZone);
  return instantOfMidnight(year, month, 1, timeZone);
}

/** Midnight on the 1st of the NEXT month, in APP_TIMEZONE (exclusive end). */
export function startOfNextMonth(value = new Date(), timeZone = APP_TIMEZONE) {
  const { year, month } = wallClock(toDate(value) || new Date(), timeZone);
  const next = new Date(Date.UTC(year, month, 1)); // month is 0-based, so +1 here
  return instantOfMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, 1, timeZone);
}

/** "YYYY-MM-DD" of `date` in APP_TIMEZONE — for <input type="date">. */
export function toDateInputValue(value = new Date(), timeZone = APP_TIMEZONE) {
  const date = toDate(value) || new Date();
  const { year, month, day } = wallClock(date, timeZone);
  const pad = (n) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** "YYYY-MM-DDTHH:mm" of `date` in APP_TIMEZONE — for <input type="datetime-local">. */
export function toDatetimeLocalValue(value, timeZone = APP_TIMEZONE) {
  const date = toDate(value);
  if (!date) return "";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(date).map((p) => [p.type, p.value])
  );
  const hour = String(Number(parts.hour) % 24).padStart(2, "0");
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}`;
}

/** "2026年09月25日" of `date` in APP_TIMEZONE. */
export function formatChineseDate(value, timeZone = APP_TIMEZONE) {
  const date = toDate(value);
  if (!date) return "—";
  const { year, month, day } = wallClock(date, timeZone);
  const pad = (n) => String(n).padStart(2, "0");
  return `${year}年${pad(month)}月${pad(day)}日`;
}
