import http from "node:http";
import { mkdir, chmod, lstat, unlink, readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { QODER_NATIVE, runOfficialNative } from "./qoder-native-identity.mjs";

// No TCP listener and no account credentials: only the gateway UID can access
// this private socket. The official helper sees this runtime's real identity.
const root = process.env.QODER_NATIVE_STATE_DIR || "/var/lib/qoder-native";
const socket = process.env.QODER_IDENTITY_SOCKET || "/run/qoder-identity/identity.sock";
const binary = process.env.QODER_NATIVE_BIN || `/opt/qoder/runtime-info-linux-${process.arch}`;
await mkdir(root, { recursive: true, mode: 0o700 });
await mkdir(dirname(socket), { recursive: true, mode: 0o700 });
try {
  const existing = await lstat(socket);
  if (!existing.isSocket()) throw new Error("Qoder identity socket path is not a socket");
  await unlink(socket);
} catch (error) { if (error.code !== "ENOENT") throw error; }
const cache = new Map();
async function stableMachineId() {
  const path = join(root, "machine-id");
  try {
    const value = (await readFile(path, "utf8")).trim();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return value;
  } catch {}
  const value = randomUUID();
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${value}\n`, { mode: 0o600, flag: "wx" });
  try { await rename(temporary, path); } catch { await unlink(temporary).catch(() => {}); }
  return (await readFile(path, "utf8")).trim();
}
const machineId = await stableMachineId();
async function identity(region) {
  const hit = cache.get(region);
  if (hit && hit.until > Date.now()) return hit.promise;
  const cwd = join(root, region);
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const promise = runOfficialNative({ binary, region, cwd }).then(async value => ({ ...value, machineId }));
  cache.set(region, { until: Date.now() + 3600000, promise });
  try { return await promise; } catch (error) { cache.delete(region); throw error; }
}
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  if (request.method === "GET" && url.pathname === "/health" && !url.search) {
    response.end(JSON.stringify({ ok: true, version: QODER_NATIVE.version })); return;
  }
  if (request.method !== "POST" || url.pathname !== "/identity" || url.search) {
    response.writeHead(404); response.end('{"error":"not_found"}'); return;
  }
  let raw = "";
  try {
    for await (const chunk of request) {
      raw += chunk.toString("utf8");
      if (raw.length > 256) throw new Error("invalid_request");
    }
    const data = JSON.parse(raw);
    if (!Object.hasOwn(QODER_NATIVE.environments, data.region) || Object.keys(data).some(k => k !== "region")) throw new Error("invalid_request");
    response.end(JSON.stringify({ identity: await identity(data.region), version: QODER_NATIVE.version }));
  } catch {
    // Never emit native output, identity strings or upstream diagnostics to logs.
    response.writeHead(503); response.end('{"error":"native_identity_unavailable"}');
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 5000;
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
await chmod(socket, 0o600);
console.log("[QoderIdentity] private socket ready");
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close(() => process.exit(0)));
