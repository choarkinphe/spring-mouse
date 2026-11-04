import { describe, it, expect, vi, afterEach } from 'vitest';
vi.mock('../../open-sse/utils/proxyFetch.js', () => ({ proxyAwareFetch: (...args) => globalThis.fetch(...args) }));
import { refreshQoderToken } from '../../open-sse/services/qoderModels.js';
afterEach(() => vi.unstubAllGlobals());

describe('Qoder rotating refresh shared by check-in and chat', () => {
  it('deduplicates concurrent and just-completed refreshes without crossing region boundaries', async () => {
    const fetch = vi.fn(async () => Response.json({ token: 'dt-new', refresh_token: 'new-refresh', expires_in: 3600000 }));
    vi.stubGlobal('fetch', fetch);
    const make = region => ({ accessToken: 'dt-old', refreshToken: 'dedup-fixture-refresh', providerSpecificData: { region } });
    const [one, two] = await Promise.all([refreshQoderToken(make('cn')), refreshQoderToken(make('cn'))]);
    expect(one).toEqual(two);
    expect(one.expiresIn).toBe(3600);
    await refreshQoderToken(make('cn'));
    expect(fetch).toHaveBeenCalledTimes(1);
    await refreshQoderToken(make('global'));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([url]) => new URL(url).hostname)).toEqual(['openapi.qoder.com.cn', 'openapi.qoder.sh']);
  });
  it('does not start a refresh for an already aborted caller', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const controller = new AbortController(); controller.abort();
    await expect(refreshQoderToken({ accessToken: 'dt-old', refreshToken: 'aborted-refresh' }, null, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
