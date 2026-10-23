// Fixture-only transport guard, inherited by Next's child workers.
// Reuse host-bootstrap suppression, proxy cleanup and loopback-only fetch guard.
require('../claude-desktop-smoke/preload.cjs');
const localFetch = globalThis.fetch;
const paths = new Set([
  '/v2/billing/meter/checkin-activity-status',
  '/v2/billing/meter/daily-checkin',
  '/v2/billing/meter/get-user-resource',
  '/v2/plugin/auth/token/refresh',
]);

globalThis.fetch = function codeBuddyFixtureFetch(input, init) {
  const raw = input instanceof URL ? input.href : typeof input === 'string' ? input : input?.url;
  let url;
  try { url = new URL(raw); } catch { return localFetch(input, init); }
  if (url.origin === 'https://copilot.tencent.com' && paths.has(url.pathname) && !url.search) {
    const target = `http://127.0.0.1:${process.env.MOCK_PORT || 9079}${url.pathname}`;
    return localFetch(input instanceof Request ? new Request(target, input) : target, { ...init, redirect: 'error' });
  }
  // Do not let even a loopback response redirect past the shared fetch guard.
  return localFetch(input, { ...init, redirect: 'error' });
};
