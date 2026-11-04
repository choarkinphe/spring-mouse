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
await updateSettings({ requireLogin: false, requireApiKey: false, rtkEnabled: false, headroomEnabled: false, pxpipeEnabled: false, cloudEnabled: false, mitmEnabled: false });
console.log('Seeded four isolated credit model accounts; no real credentials');
