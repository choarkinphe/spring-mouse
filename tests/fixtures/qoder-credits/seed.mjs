import path from 'node:path';
if (!path.basename(path.dirname(process.env.DATA_DIR || '')).startsWith('sm-qoder-credits.') || !global.__appBootstrapped) throw new Error('Requires isolated credit fixture');
const { createProviderConnection, getProviderConnections, updateSettings } = await import('../../../src/lib/db/index.js');
if ((await getProviderConnections()).length) throw new Error('Fixture database must be empty');
for (const [provider, region] of [['qoder', 'global'], ['qoder-cn', 'cn']]) await createProviderConnection({
  provider, authType: 'oauth', name: `${provider} 积分模拟账号`, accessToken: 'dt-fixture-not-real',
  expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), isActive: true,
  providerSpecificData: { region, userId: `${provider}-fixture-user`, machineId: 'fixture-machine-not-real' },
});
for (const [provider, origin] of [['workbuddy', 'https://copilot.tencent.com'], ['workbuddy-ai', 'https://www.workbuddy.ai']]) await createProviderConnection({
  provider, authType: 'oauth', name: `${provider} 积分模拟账号`, accessToken: 'fixture-not-real', isActive: true,
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
  providerSpecificData: { workbuddyLegacyCredential: false, workbuddyProduct: provider, workbuddyPlatform: provider, workbuddyContract: '0.1.30', workbuddyOrigin: origin, domain: new URL(origin).hostname, codebuddyUid: `${provider}-fixture-user`, tokenType: 'Bearer' },
});
// Reproduce the production queue wrapper and an obsolete, terminal precheck.
const { updateProviderConnectionHealth } = await import('../../../src/lib/db/repos/connectionsRepo.js');
const { updateCheckinState } = await import('../../../src/lib/db/repos/checkinRepo.js');
const globalAccount = (await getProviderConnections()).find(c => c.provider === 'qoder');
const queue = { code: '10605', message: JSON.stringify({ isQueued: true, retryAfterSeconds: 30, serviceAvailable: false, subCode: 'RESOURCE_LIMIT' }) };
await updateProviderConnectionHealth(globalAccount.id, () => ({ update: {
  lastUpstreamError: JSON.stringify(queue), lastUpstreamRaw: JSON.stringify({ code: '403', message: JSON.stringify(queue) }), lastUpstreamStatus: 200,
  lastUpstreamSource: 'sse', lastUpstreamLayer: 'provider', lastUpstreamAt: new Date().toISOString(),
} }));
await updateCheckinState(globalAccount.id, () => ({ enabled: true, status: 'own_app', message: 'Qoder 国际版签到需要官方设备身份，请在当前主机安装并登录 Qoder 官方客户端或 CLI，或在官方客户端签到', terminalDate: new Date().toISOString().slice(0, 10), lastAttemptAt: new Date().toISOString() }));
await updateSettings({ requireLogin: false, requireApiKey: false, rtkEnabled: false, headroomEnabled: false, pxpipeEnabled: false, cloudEnabled: false, mitmEnabled: false });
console.log('Seeded four isolated credit model accounts; no real credentials');
