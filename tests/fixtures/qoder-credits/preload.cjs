// Isolated fixture: suppress background jobs and block all real upstream fetch.
require('../claude-desktop-smoke/preload.cjs');
const guardedFetch = globalThis.fetch;
let claimed = false;
globalThis.fetch = function creditsFixtureFetch(input, init) {
  const raw = input instanceof URL ? input.href : typeof input === 'string' ? input : input?.url;
  let url; try { url = new URL(raw); } catch { return guardedFetch(input, init); }
  const qoder = ['api3.qoder.sh', 'api2.qoder.sh', 'gateway.qoder.com.cn', 'openapi.qoder.sh', 'openapi.qoder.com.cn'].includes(url.hostname);
  const wb = ['copilot.tencent.com', 'www.workbuddy.ai'].includes(url.hostname);
  if (!qoder && !wb) return guardedFetch(input, init);
  if (url.pathname.endsWith('/model/list')) return Promise.resolve(Response.json({
    app: [
      { key: 'fast', display_name: 'Fast', price_factor: 0.8, enable: true },
      { key: 'ultimate', display_name: 'Ultimate', price_factor: 2, enable: true },
      { key: 'qfmodel', display_name: 'Qwen3.8-Flash', price_factor: 0, original_price_factor: 0.1, enable: true, max_input_tokens: 1048576, is_vl: true },
      { key: 'qmodel_38max', display_name: 'Qwen3.8-Max', price_factor: 0.5, enable: true },
    ], chat: [
      { key: 'performance', display_name: 'Performance', price_factor: 1.1, enable: true },
      { key: 'dfmodel', display_name: 'DeepSeek-Flash', price_factor: 0.1, enable: true },
      { key: 'auto', display_name: 'Auto', enable: true },
    ],
  }));
  if (url.pathname === '/v3/config') return Promise.resolve(Response.json({ code: 0, data: {
    agents: [{ name: 'cli', models: ['glm-5.3-flash', 'deepseek-v4.1-flash', 'deepseek-v4-pro'] }],
    models: [
      { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', credits: 'x0.08' },
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', credits: url.hostname === 'www.workbuddy.ai' ? 'x0.00' : 'x0.11' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', credits: 'x0.51' },
    ],
  } }));
  if (url.pathname === '/sash/api/v1/me/campaigns') {
    const start = Math.floor((Date.now() - 2 * 3600000) / 86400000) * 86400000 + 2 * 3600000;
    return Promise.resolve(Response.json({ campaigns: [{ campaignId: 'fixture-daily', actionType: 'CLAIM_BENEFIT', claimStatus: claimed ? 'CLAIMED' : 'CLAIMABLE', startAt: start, endAt: start + 86400000 - 60000, benefit: { kind: 'CREDITS', amount: 50 } }] }));
  }
  if (url.pathname === '/sash/api/v1/me/campaigns/fixture-daily/claim' && init?.method === 'POST') {
    claimed = true;
    return Promise.resolve(Response.json({ status: 'CLAIMED', benefit: { amount: 50 } }));
  }
  return Promise.reject(new Error('Credit fixture blocks unconfigured upstream request'));
};
