/**
 * Timezone-aware day boundaries for the runtime/ subsystem.
 *
 * WHY THIS EXISTS: the rollup keys rows by "day", and a day is only meaningful
 * relative to a timezone. The original code used `setHours(0,0,0,0)`, i.e. the
 * PROCESS's local day — correct only as long as the process happens to run in the
 * same zone the operator thinks in. On the production container (TZ=Asia/Shanghai)
 * that held; on CI (UTC) it did not, so a client range aligned to Asia/Shanghai
 * failed the server's day-alignment gate and silently fell back to the slow raw
 * path. Pinning the basis to APP_TIMEZONE removes the dependency on process TZ and
 * makes the client range, the gate, and the stored keys agree everywhere.
 *
 * CONSTRAINT: `runtime/` ships as real files with no `@/` or `open-sse/` alias
 * imports, so this module must stay self-contained (node builtins only).
 */

export const APP_TIMEZONE = process.env.NEXT_PUBLIC_APP_TIMEZONE || "Asia/Shanghai";

const PARTS_FMT = new Map();
function partsFormatter(timeZone) {
  let fmt = PARTS_FMT.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    PARTS_FMT.set(timeZone, fmt);
  }
  return fmt;
}

function partsOf(date, timeZone) {
  return Object.fromEntries(
    partsFormatter(timeZone).formatToParts(date).map((p) => [p.type, p.value])
  );
}

/** Offset of `timeZone` at `date`, in minutes east of UTC. */
function offsetMinutes(date, timeZone) {
  const p = partsOf(date, timeZone);
  const asUTC = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour) % 24, Number(p.minute), Number(p.second)
  );
  return (asUTC - date.getTime()) / 60000;
}

/** The wall-clock {year, month, day} of `date` in `timeZone`. */
export function wallClock(value, timeZone = APP_TIMEZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const p = partsOf(date, timeZone);
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day) };
}

/** The instant of `y-m-d 00:00:00` in `timeZone`. */
export function instantOfMidnight(y, m, d, timeZone = APP_TIMEZONE) {
  let ms = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  for (let i = 0; i < 2; i++) {
    ms = Date.UTC(y, m - 1, d, 0, 0, 0, 0) - offsetMinutes(new Date(ms), timeZone) * 60000;
  }
  return new Date(ms);
}

/** Midnight at the start of `value`'s day, in `timeZone`. */
export function startOfDay(value = new Date(), timeZone = APP_TIMEZONE) {
  const wc = wallClock(value, timeZone);
  if (!wc) return new Date(NaN);
  return instantOfMidnight(wc.year, wc.month, wc.day, timeZone);
}

/** The last millisecond of `value`'s day, in `timeZone`. */
export function endOfDay(value = new Date(), timeZone = APP_TIMEZONE) {
  const start = startOfDay(value, timeZone);
  return new Date(start.getTime() + 24 * 3600_000 - 1);
}

/** "YYYY-MM-DD" of `value` in `timeZone` — the rollup's day key. */
export function localDateKey(value, timeZone = APP_TIMEZONE) {
  const wc = wallClock(value, timeZone);
  if (!wc) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${wc.year}-${pad(wc.month)}-${pad(wc.day)}`;
}
