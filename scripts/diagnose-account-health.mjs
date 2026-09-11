#!/usr/bin/env node
/**
 * 只读诊断：渠道账号健康 + 模型锁 + 熔断/并发策略 + 近期请求分布
 *
 *   node scripts/diagnose-account-health.mjs [--db <path>] [--minutes 60]
 *
 * 只读打开数据库，不发任何请求、不写任何记录。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const dbPath = arg("--db", join(homedir(), ".spring-mouse", "db", "data.sqlite"));
const minutes = Number(arg("--minutes", "60")) || 60;

if (!existsSync(dbPath)) {
  console.error(`找不到数据库：${dbPath}\n用 --db 指定实际路径（容器里通常是挂载卷下的 data.sqlite）`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const all = (sql, ...params) => {
  try { return db.prepare(sql).all(...params); } catch { return []; }
};

const now = Date.now();
const rel = (ts) => {
  const s = Math.round((new Date(ts).getTime() - now) / 1000);
  if (s < 0) return "已过期";
  return s >= 60 ? `${Math.round(s / 60)}分` : `${s}秒`;
};

console.log("");
console.log(`库    ${dbPath}  (${(statSync(dbPath).size / 1048576).toFixed(0)} MB)`);
console.log(`时间  ${new Date().toLocaleString("zh-CN")}`);

const conns = all("SELECT id, provider, name, isActive, priority, data FROM providerConnections ORDER BY provider, priority");
const byProv = new Map();
for (const c of conns) {
  if (!byProv.has(c.provider)) byProv.set(c.provider, []);
  byProv.get(c.provider).push(c);
}

console.log("");
console.log("=== 账号健康 ===");
if (!conns.length) console.log("  (库里没有账号)");
for (const [prov, list] of byProv) {
  const active = list.filter((c) => c.isActive === 1);
  console.log("");
  console.log(`[${prov}]  共 ${list.length} · 启用 ${active.length}`);
  for (const c of list) {
    let d = {};
    try { d = JSON.parse(c.data || "{}"); } catch { /* 保持空对象 */ }
    const locks = Object.entries(d)
      .filter(([k, v]) => k.startsWith("modelLock_") && v && new Date(v).getTime() > now)
      .map(([k, v]) => `${k.slice(10)} 剩${rel(v)}`);
    const flags = [];
    if (c.isActive !== 1) flags.push("已停用");
    if (locks.length) flags.push("LOCK " + locks.join(" / "));
    if (d.backoffLevel) flags.push(`退避${d.backoffLevel}级`);
    if (d.testStatus && d.testStatus !== "active") flags.push(`test=${d.testStatus}`);
    if (d.lastError) flags.push(`err=${String(d.lastError).slice(0, 48)}`);
    const dot = c.isActive === 1 ? "●" : "○";
    console.log(`  ${dot} ${String(c.name || c.id).slice(0, 30).padEnd(30)} ${flags.join("  ") || "正常"}`);
  }
}

console.log("");
console.log("=== 渠道策略（并发 / 熔断 / 分配）===");
const settingsRow = all("SELECT data FROM settings WHERE id = 1")[0];
let settings = {};
try { settings = JSON.parse(settingsRow?.data || "{}"); } catch { /* 保持空对象 */ }
const strategies = settings.providerStrategies || {};
for (const [prov, list] of byProv) {
  const o = strategies[prov] || {};
  const hard = o.hardConcurrencyEnabled === false ? "已关闭" : (o.providerMaxConcurrentStreams ?? "registry 默认");
  const breakerOn = o.enableModelBreaker === false ? "关闭" : "开启";
  const cooldownS = Math.round((o.breakerCooldownMs ?? 60000) / 1000);
  console.log(`  [${prov}] 启用${list.filter((c) => c.isActive === 1).length}个账号  渠道总并发=${hard}  单账号=${o.maxConcurrentStreams ?? "registry 默认"}  分配=${o.fallbackStrategy || "fill-first(默认)"}`);
  console.log(`      熔断=${breakerOn}  阈值=${o.breakerThreshold ?? 3}次/${Math.round((o.breakerWindowMs ?? 120000) / 1000)}s  冷却=${cooldownS}s`);
}

console.log("");
console.log(`=== 近 ${minutes} 分钟请求分布 ===`);
const since = new Date(now - minutes * 60000).toISOString();
const usage = all(
  "SELECT provider, status, COUNT(*) AS n FROM usageHistory WHERE timestamp >= ? GROUP BY provider, status ORDER BY n DESC",
  since,
);
if (!usage.length) {
  console.log("  (该窗口内无记录，或 usageHistory 表不存在)");
} else {
  for (const u of usage) {
    console.log(`  ${String(u.provider).slice(0, 34).padEnd(34)} ${String(u.status).padEnd(9)} ${u.n}`);
  }
}

const totals = all(
  "SELECT status, COUNT(*) AS n FROM usageHistory WHERE timestamp >= ? GROUP BY status",
  since,
);
if (totals.length) {
  const ok = totals.filter((t) => ["success", "ok"].includes(t.status)).reduce((s, t) => s + t.n, 0);
  const all_n = totals.reduce((s, t) => s + t.n, 0);
  console.log("");
  console.log(`  合计 ${all_n} 条，成功 ${ok} 条，成功率 ${all_n ? ((ok / all_n) * 100).toFixed(1) : "0"}%`);
}

console.log("");
