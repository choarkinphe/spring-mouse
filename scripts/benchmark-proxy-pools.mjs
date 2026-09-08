// Structural allocation benchmark, not a socket/RSS load test. No network or
// credentials: run the real cache code with an inert ProxyAgent and fetch.
// Usage: node scripts/benchmark-proxy-pools.mjs [baseline-git-ref]
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { setImmediate as nextTurn } from 'node:timers/promises';

const root = new URL('../', import.meta.url);
const relativePath = 'open-sse/utils/proxyFetch.js';
const baselineRef = process.argv[2] || 'HEAD';
const sources = [
  ['baseline', execFileSync('git', ['show', `${baselineRef}:${relativePath}`], { cwd: root, encoding: 'utf8' })],
  ['working-tree', await readFile(new URL(relativePath, root), 'utf8')],
];
const originalFetch = globalThis.fetch;
try {
  for (const [version, source] of sources) {
    for (const [scenario, count, sameProxy] of [['same-proxy', 100, true], ['different-proxies', 40, false]]) {
      const agents = [];
      let dispatched = 0;
      let dispatchedAfterClose = 0;
      globalThis.__smBenchProxyAgent = class {
        constructor() { this.closed = false; agents.push(this); }
        async close() { this.closed = true; }
      };
      globalThis.fetch = async (_url, { dispatcher }) => {
        dispatched++;
        if (dispatcher.closed) dispatchedAfterClose++;
        return new Response(null, { status: 204 });
      };
      const instrumented = source
        .replace('import { MEMORY_CONFIG } from "../config/runtimeConfig.js";', 'const MEMORY_CONFIG = { proxyDispatchersMaxSize: 20 };')
        .replace('import { dbg } from "./debugLog.js";', 'const dbg = () => {};')
        .replaceAll('import("undici")', 'Promise.resolve({ ProxyAgent: globalThis.__smBenchProxyAgent })');
      const { proxyAwareFetch } = await import(`data:text/javascript;base64,${Buffer.from(instrumented + `\n// ${version}-${scenario}`).toString('base64')}`);
      await Promise.all(Array.from({ length: count }, (_, i) => proxyAwareFetch('https://benchmark.invalid/chat', {}, {
        enabled: true, url: `http://127.0.0.1:${8100 + (sameProxy ? 0 : i)}`, strictProxy: true,
      })));
      await nextTurn();
      console.log(JSON.stringify({ version, scenario, dispatched, created: agents.length, closed: agents.filter(a => a.closed).length, dispatchedAfterClose }));
    }
  }
} finally {
  globalThis.fetch = originalFetch;
  delete globalThis.__smBenchProxyAgent;
}
