import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ agents: [] }));
let originalFetch;
let fetchMock;
let proxyAwareFetch;
beforeEach(async () => {
  vi.resetModules();
  vi.doMock("undici", () => ({
    ProxyAgent: class {
      constructor(options) {
        this.options = options;
        this.close = vi.fn(async () => {});
        state.agents.push(this);
      }
    },
  }));

  state.agents.length = 0;
  originalFetch = globalThis.fetch;
  fetchMock = vi.fn(async (_url, { dispatcher }) => {
    expect(dispatcher.close).not.toHaveBeenCalled();
    return new Response('ok');
  });
  globalThis.fetch = fetchMock;
  ({ proxyAwareFetch } = await import('../../open-sse/utils/proxyFetch.js'));
});
afterEach(() => { globalThis.fetch = originalFetch; });
const call = (port) => proxyAwareFetch('https://example.test/chat', {}, { enabled: true, url: `http://127.0.0.1:${port}`, strictProxy: true });
describe('proxy dispatcher ownership', () => {
  it('creates one pool for 100 simultaneous first requests to the same proxy', async () => {
    await Promise.all(Array.from({ length: 100 }, () => call(8100)));
    expect(state.agents).toHaveLength(1);
    expect(new Set(fetchMock.mock.calls.map(([, init]) => init.dispatcher)).size).toBe(1);
  });
  it('closes evicted pools gracefully and keeps only 20 reusable pools', async () => {
    for (let i = 0; i < 25; i++) await call(8100 + i);
    await nextTurn();
    expect(state.agents.filter(a => a.close.mock.calls.length)).toHaveLength(5);
    await call(8124);
    expect(state.agents).toHaveLength(25);
  });
  it('does not wait for a retiring pool to finish draining', async () => {
    await call(8200);
    state.agents[0].close.mockImplementation(() => new Promise(() => {}));
    for (let i = 1; i <= 20; i++) await call(8200 + i);
    await nextTurn();
    expect(state.agents[0].close).toHaveBeenCalledTimes(1);
    expect((await call(8221)).status).toBe(200);
    await nextTurn();
  });
  it('applies the capacity check after concurrent initialization', async () => {
    await Promise.all(Array.from({ length: 40 }, (_, i) => call(8100 + i)));
    await nextTurn();
    expect(state.agents.filter(a => a.close.mock.calls.length)).toHaveLength(20);
  });
});
