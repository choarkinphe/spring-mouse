import path from 'node:path';
if (!path.basename(path.dirname(process.env.DATA_DIR || '')).startsWith('sm-account-billing.') || !global.__appBootstrapped) throw new Error('Requires isolated account billing fixture');
const { createProviderConnection, updateProviderConnection, updateSettings } = await import('../../../src/lib/db/index.js');
const { getAdapter } = await import('../../../src/lib/db/driver.js');
const { appendAccountBillingEntry } = await import('../../../src/lib/db/repos/accountBillingRepo.js');
const { startOfDay } = await import('../../../src/shared/utils/datetime.js');
const db = await getAdapter();
if (db.get('SELECT COUNT(*) AS n FROM providerConnections').n) throw new Error('Fixture DB must be empty');
await updateSettings({ requireLogin: false, requireApiKey: false, rtkEnabled: false, headroomEnabled: false, pxpipeEnabled: false, cloudEnabled: false, mitmEnabled: false });
const now = Date.now();
const day = 86400000;
const accounts = [];
for (const [provider, authType, name, mode] of [
  ['codex', 'oauth', 'Codex 月付模拟账号', 'subscription'],
  ['openai', 'apikey', 'OpenAI 按量模拟账号', 'metered'],
  ['qoder', 'oauth', '零用量订阅模拟账号', 'subscription'],
  ['deepseek', 'apikey', '混合付费模拟账号', 'hybrid'],
  ['openai-compatible-fixture', 'apikey', '待确认计费模拟账号', 'unknown'],
]) {
 const connection = await createProviderConnection({provider,authType,name,isActive:true,apiKey:'fixture-not-real',accessToken:'fixture-not-real'});
 await updateProviderConnection(connection.id, {billingMode:mode});
 accounts.push({...connection,billingMode:mode});
}
for (const [i, currency, amount] of [[0,'CNY',120],[2,'USD',20],[3,'USD',10]]) {
 await appendAccountBillingEntry(accounts[i].id,{amount,currency,paidAt:new Date(startOfDay(now).getTime()+3600000).toISOString(),startAt:new Date(now-10*day).toISOString(),endAt:new Date(now+20*day).toISOString(),note:'隔离模拟订阅，不是真实账单'});
}
for (let i=0;i<accounts.length;i++) {
 if(i===2) continue;
 for(let n=0;n<4;n++) {
  const timestamp = new Date(now - n*3600000).toISOString();
  const input=(i+1)*100000, output=(i+1)*25000;
  const model=i===0?'gpt-5.6-sol':i===1?'gpt-4o':i===3?'deepseek-chat':'fixture-model';
  db.run(`INSERT INTO usageHistory(timestamp,provider,model,connectionId,promptTokens,completionTokens,cost,status,tokens,requestId) VALUES(?,?,?,?,?,?,?,?,?,?)`,[timestamp,accounts[i].provider,model,accounts[i].id,input,output,i===0?3:i===1?0.75:i===3?0.2:0,'success',JSON.stringify({prompt_tokens:input,completion_tokens:output,cached_tokens:input/2,cache_creation_input_tokens:input/10}),`billing-fixture-${i}-${n}`]);
 }
}
db.flush?.();
console.log('Seeded isolated subscription/metered/hybrid/unknown accounts and cached Token usage. No real credentials.');
