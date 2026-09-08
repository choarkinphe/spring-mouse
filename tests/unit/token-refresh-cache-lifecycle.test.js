import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
let dedupRefresh;
let debug;
beforeEach(async () => {
  vi.useFakeTimers(); vi.resetModules();
  ({ dedupRefresh, __test__: debug } = await import('../../open-sse/services/tokenRefresh/dedup.js'));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
describe('refresh cache lifecycle', () => {
  it('does not retain a synchronously rejected in-flight entry', async () => {
    await expect(dedupRefresh('test', 'old', () => { throw new Error('sync'); })).rejects.toThrow('sync');
    await expect(dedupRefresh('test', 'old', async () => 'recovered')).resolves.toBe('recovered');
  });
  it('evicts settled credentials without another access to the old token', async () => {
    await dedupRefresh('test', 'rotated-old-token', async () => ({ accessToken: 'new' }));
    expect(debug.cacheSize()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(debug.cacheSize()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps in-flight refresh single-flight even beyond the result TTL', async () => {
    let resolve;
    const fn = vi.fn(() => new Promise(r => { resolve = r; }));
    const a = dedupRefresh('test', 'old', fn);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20_000);
    const b = dedupRefresh('test', 'old', fn);
    resolve('ok');
    expect(await Promise.all([a, b])).toEqual(['ok', 'ok']);
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('reuses fresh results but retries expired ones and isolates providers', async () => {
    const fn = vi.fn(async () => 'fresh');
    expect(await dedupRefresh('a', 'token', fn)).toBe('fresh');
    expect(await dedupRefresh('a', 'token', fn)).toBe('fresh');
    expect(fn).toHaveBeenCalledTimes(1);
    await dedupRefresh('b', 'token', fn);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_001);
    await dedupRefresh('a', 'token', fn);
    expect(fn).toHaveBeenCalledTimes(3);
  });
  it('does not cache an asynchronous rejection', async () => {
    await expect(dedupRefresh('a', 'token', async () => { throw new Error('failed'); })).rejects.toThrow('failed');
    expect(debug.cacheSize()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await expect(dedupRefresh('a', 'token', async () => 'ok')).resolves.toBe('ok');
  });
  it('evicts staggered results within one cleanup interval of expiry', async () => {
    await dedupRefresh('a', 'one', async () => 'ok');
    await vi.advanceTimersByTimeAsync(5000);
    await dedupRefresh('a', 'two', async () => 'ok');
    await vi.advanceTimersByTimeAsync(5000);
    expect(debug.cacheSize()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(debug.cacheSize()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds settled results during a burst and expires them with one timer', async () => {
    await Promise.all(Array.from({ length: 1500 }, (_, i) => dedupRefresh('test', `old-${i}`, async () => 'new')));
    expect(debug.cacheSize()).toBeLessThanOrEqual(1000);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(debug.cacheSize()).toBe(0);
  });
});
