// Fixture-only fetch guard. No real credentials or non-loopback fetch egress.
require('../claude-desktop-smoke/preload.cjs');
const localFetch = globalThis.fetch;
globalThis.fetch = function fixtureFetch(input, init) {
  const raw = input instanceof URL ? input.href : typeof input === 'string' ? input : input?.url;
  if (raw === 'https://api.deepseek.com/v1/tools/search') {
    const target = `http://127.0.0.1:${process.env.MOCK_PORT || 9067}/v1/tools/search`;
    // Only rewrite the dedicated search transport. Chat/user auth is untouched.
    return localFetch(input instanceof Request ? new Request(target, input) : target, init);
  }
  return localFetch(input, init);
};
