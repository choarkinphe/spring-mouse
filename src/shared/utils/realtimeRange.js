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

export const REALTIME_PRESETS = [
  { value: "24h", label: "24 小时", hours: 24 },
  { value: "48h", label: "48 小时", hours: 48 },
];

/**
 * Build the rolling range for a preset.
 *
 * `end` is pinned to the current instant (not end-of-day) so the window really
 * is "the last N hours" — "today" would reset at midnight and show an empty
 * page right after it.
 *
 * The server treats an explicit startDate/endDate as authoritative and ignores
 * `period` when both are present, so this is all the caller needs to send.
 */
export function realtimeRange(preset = "24h", now = new Date()) {
  const hours = REALTIME_PRESETS.find((p) => p.value === preset)?.hours ?? 24;
  return {
    preset,
    startDate: new Date(now.getTime() - hours * 3600_000).toISOString(),
    endDate: new Date(now).toISOString(),
  };
}
