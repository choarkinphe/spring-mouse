/**
 * Rolling-window helpers for the dashboard home page.
 *
 * Kept out of the component file so it can be unit-tested: the test runner does
 * not transform JSX in `.js` files (the app relies on Next's SWC), so anything
 * living in a component file is untestable.
 *
 * The home page answers "what is happening right now", so it uses rolling
 * windows rather than calendar periods. This is the distinction from
 * `UsageTimeFilter`, which drives the usage board's calendar navigation.
 */

/**
 * The home page's windows.
 *
 * `24h`/`48h` are ROLLING (ending now): that is the point of a realtime view, and
 * a sub-day window has no day-granular equivalent anyway.
 *
 * `7d` is CALENDAR-ALIGNED instead, because a rolling 168h window cannot be
 * served from the daily rollup — it would force a full `usageHistory` scan,
 * measured at 8.8s on production versus ~100ms from the rollup. Aligning it to
 * local midnight buys that 80x, at the cost of "近 7 天" meaning the last 7
 * calendar days rather than the last 168 hours.
 */
export const REALTIME_PRESETS = [
  { value: "24h", label: "24 小时", hours: 24 },
  { value: "48h", label: "48 小时", hours: 48 },
  { value: "7d", label: "近 7 天", hours: 24 * 7, days: 7, dayAligned: true },
];

/**
 * Build the range for a preset.
 *
 * A rolling preset ends at the current instant (not end-of-day) so the window
 * really is "the last N hours" — "today" would reset at midnight and show an
 * empty page right after it. A day-aligned preset spans whole local days, so it
 * starts at local midnight and ends at local end-of-day; the server's
 * day-alignment gate then lets the rollup serve it.
 *
 * The server treats an explicit startDate/endDate as authoritative and ignores
 * `period` when both are present, so this is all the caller needs to send.
 */
export function realtimeRange(preset = "24h", now = new Date()) {
  const config = REALTIME_PRESETS.find((p) => p.value === preset);

  if (config?.dayAligned) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (config.days - 1));   // "近 7 天" includes today
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    return { preset, startDate: start.toISOString(), endDate: end.toISOString() };
  }

  const hours = config?.hours ?? 24;
  return {
    preset,
    startDate: new Date(now.getTime() - hours * 3600_000).toISOString(),
    endDate: new Date(now).toISOString(),
  };
}
