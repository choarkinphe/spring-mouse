import { pathToFileURL } from 'node:url';
const qoderSeed = new URL('../qoder-credits/seed.mjs', import.meta.url);
await import(pathToFileURL(qoderSeed.pathname).href);
const { getProviderConnections, updateProviderConnection } = await import('../../../src/lib/db/index.js');
const connection = (await getProviderConnections()).find((item) => item.provider === 'qoder');
const raw = JSON.stringify({ code: 112, message: 'Quota exceeded', detail: 'synthetic-upstream-detail '.repeat(300), request_id: 'fixture-original-request-at-tail' }, null, 2);
await updateProviderConnection(connection.id, {
  name: '失败分析模拟账号', testStatus: 'limited',
  testStatusUntil: new Date(Date.now() + 3600000).toISOString(),
  lastUpstreamError: '上游额度限制（112），请刷新积分核实余额或订阅；不是登录失效',
  lastUpstreamRaw: raw, lastUpstreamStatus: 200, lastUpstreamSource: 'sse',
  lastUpstreamLayer: 'provider', lastUpstreamAt: new Date().toISOString(),
});
console.log(`Seeded synthetic upstream error (${raw.length} chars), including a request ID beyond 4000 chars`);
