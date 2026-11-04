// Synthetic native identity only; never used outside isolated fixture HOME.
import http from 'node:http';
if (!process.env.HOME?.includes('sm-qoder-credits.') || !process.env.QODER_IDENTITY_SOCKET?.startsWith(process.env.HOME)) throw new Error('Requires isolated fixture');
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  if (req.method !== 'POST' || req.url !== '/identity' || JSON.parse(raw).region !== 'global') { res.writeHead(400); res.end('{}'); return; }
  res.end(JSON.stringify({ identity: { machineToken: 'synthetic-native-token', machineType: 'synthetic-native-type', machineCode: 'synthetic-native-code', machineId: 'synthetic-device-id' } }));
});
server.listen(process.env.QODER_IDENTITY_SOCKET);
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close(() => process.exit(0)));
