#!/usr/bin/env node
/**
 * 路由决策链探针 —— 只读，不发请求、不写库。
 *
 * 把面板日志缓冲区（/api/translator/console-logs）里散落的准入事件，
 * 还原成一条可读的「请求决策链」，直接回答：**我的请求死在哪一关**。
 *
 *   node scripts/probe-routing.mjs                    # 抓当前缓冲，出决策链 + 结论
 *   node scripts/probe-routing.mjs --clear            # 先清空缓冲（发探针请求之前跑）
 *   node scripts/probe-routing.mjs --watch 60         # SSE 实时盯 60 秒，边发请求边看
 *   node scripts/probe-routing.mjs --base http://host:8008 --env /path/.env
 *   node scripts/probe-routing.mjs --json             # 机器可读输出
 *
 * 会话密钥来源（按顺序）：--env 里的 JWT_SECRET → <data-dir>/jwt-secret
 *
 * ⚠️ 面板日志缓冲只有 200 行（内存，重启即清）。高频流量下几分钟就被冲掉，
 *    所以它适合「现场抓一次」，不适合事后翻旧账 —— 事后查库用
 *    scripts/diagnose-account-health.mjs。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const base = (arg("base", process.env.SM_BASE || "http://localhost:8007")).replace(/\/+$/, "");
const dataDir = arg("data-dir", process.env.DATA_DIR || path.join(os.homedir(), ".spring-mouse"));
const envFile = arg("env", path.join(process.cwd(), ".env"));
const watchSec = Number(arg("watch", "0")) || 0;
const limit = Number(arg("limit", "150")) || 150;
const wantJson = flag("json");

// ---------------------------------------------------------------- 会话 cookie
function sessionCookie() {
  let secret = "";
  const explicit = arg("secret", null);
  if (explicit) secret = explicit;
  if (!secret && envFile && fs.existsSync(envFile)) {
    const m = fs.readFileSync(envFile, "utf8").match(/^\s*JWT_SECRET\s*=\s*(.+)$/m);
    if (m) secret = m[1].trim().replace(/^["']|["']$/g, "");
  }
  if (!secret) {
    try { secret = fs.readFileSync(path.join(dataDir, "jwt-secret"), "utf8").trim(); } catch { /* ignore */ }
  }
  if (!secret) return null;
  const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ authenticated: true, iat: now, exp: now + 3600 })}`;
  return `auth_token=${input}.${crypto.createHmac("sha256", secret).update(input).digest("base64url")}`;
}

const cookie = sessionCookie();
if (!cookie) {
  console.error(`找不到会话密钥。用 --env <含 JWT_SECRET 的 .env>，或 --secret <值>，或提供 ${path.join(dataDir, "jwt-secret")}`);
  process.exit(2);
}

// ---------------------------------------------------------------- 事件分类器
// 每条规则把一行日志映射成一次「准入事件」。severity=gate 表示请求被挡下。
const RULES = [
  { id: "GATE_LOCKED", sev: "gate", icon: "🚫", label: "账号全被锁",
    re: /all (\d+) accounts locked for (\S+?) \(([^)]+)\)(?:\s*\|\s*lastError=(.*))?$/,
    fmt: (m) => `${m[1]} 个账号对「${m[2]}」全部处于锁定态（${m[3]}）` +
      (m[4] && !/^(undefined|null)$/.test(m[4].trim()) ? `｜最后错误: ${m[4].slice(0, 70)}` : "") },
  { id: "GATE_BREAKER", sev: "gate", icon: "🔥", label: "模型熔断中",
    re: /(\S+) cooling down \(([^)]+)\)/,
    fmt: (m) => `${m[1]} 熔断打开，冷却 ${m[2]}（此间请求连账号都不选）` },
  { id: "GATE_UNAVAILABLE", sev: "gate", icon: "🚫", label: "账号全不可用",
    re: /(\S+) \| all (\d+) accounts unavailable$/,
    fmt: (m) => `${m[1]} 的 ${m[2]} 个账号全部不可用（停用/节点离线）` },
  { id: "GATE_QUEUE", sev: "gate", icon: "⏳", label: "并发排队超时",
    re: /(\S+) \| queue timeout after (\d+)ms/,
    fmt: (m) => `${m[1]} 并发槽位等待 ${Math.round(Number(m[2]) / 1000)} 秒仍未空出（429）` },
  { id: "GATE_NO_CREDS", sev: "gate", icon: "🚫", label: "无可用凭据",
    re: /No active credentials for provider: (\S+)/,
    fmt: (m) => `${m[1]} 没有任何可用账号` },
  { id: "GATE_EXHAUSTED", sev: "gate", icon: "🚫", label: "账号已试完",
    re: /No more accounts available/,
    fmt: () => "所有账号都试过且全部失败" },
  { id: "GATE_TAGS", sev: "gate", icon: "🔒", label: "combo 标签拒绝",
    re: /(\S+) \| denied by combo access tags/,
    fmt: (m) => `${m[1]} 被 combo 访问标签拒绝` },
  { id: "GATE_MODEL_FMT", sev: "gate", icon: "🚫", label: "模型格式错",
    re: /Invalid model format/, fmt: () => "请求里的模型名格式无法解析" },

  { id: "BREAKER_OPEN", sev: "warn", icon: "🔺", label: "熔断被打开",
    re: /(\S+) \| opened provider\/model breaker \((\d+)\)/,
    fmt: (m) => `${m[1]} 因上游 ${m[2]} 连续失败，熔断打开` },
  { id: "FALLBACK", sev: "warn", icon: "⇄", label: "账号失败换下一个",
    re: /ACC:(\S+) UNAVAILABLE \((\d+)\) → NEXT ACCOUNT/,
    fmt: (m) => `账号 ${m[1]} 返回 ${m[2]}，已切换下一个` },
  { id: "UPSTREAM_ERR", sev: "warn", icon: "⚠️", label: "上游报错",
    re: /\[(\S+\/\S+)\] (.+?) \(([^)]+)\)$/,
    fmt: (m) => `${m[1]} → ${m[2].slice(0, 90)}｜${m[3]}` },

  { id: "DISPATCH_RR", sev: "ok", icon: "✅", label: "轮转派发",
    re: /(\S+) \| request-rotate #(\d+) → (\S+?) \| accounts=(\d+)/,
    fmt: (m) => `${m[1]} 第 ${m[2]} 次轮转 → 账号「${m[3]}」（可选 ${m[4]} 个）` },
  { id: "DISPATCH_STICKY", sev: "ok", icon: "✅", label: "粘滞命中",
    re: /(\S+) \| user=(\S+) \| (sticky-hit|rotated) → (\S+?) \| accounts=(\d+)/,
    fmt: (m) => `${m[1]} 用户 ${m[2]} ${m[3] === "sticky-hit" ? "粘滞命中" : "改派"} → 账号「${m[4]}」（可选 ${m[5]} 个）` },
  { id: "PINNED", sev: "ok", icon: "📌", label: "指定账号",
    re: /(\S+) \| pinned to (\S+) \(([^)]+)\)/,
    fmt: (m) => `${m[1]} 被指定到 ${m[2]}（${m[3]}）` },

  { id: "AVAILABILITY", sev: "info", icon: "ℹ️", label: "准入明细",
    re: /(\S+) \| available: (\d+)\/(\d+)/,
    fmt: (m) => `${m[1]} 可用账号 ${m[2]}/${m[3]}` },
  { id: "LOCK_DETAIL", sev: "info", icon: "🔒", label: "账号被锁",
    re: /→ (\S+) \|\s*(excluded|modelLocked)/,
    fmt: (m) => `账号 ${m[1]} ${m[2] === "excluded" ? "被排除（重试排除集）" : "挂着模型锁"}` },
  { id: "COMBO", sev: "info", icon: "🧩", label: "组合展开",
    re: /Combo "([^"]+)" with (\d+) compatible models \(strategy: (\w+)/,
    fmt: (m) => `组合「${m[1]}」展开为 ${m[2]} 个模型，策略 ${m[3]}` },
];

const NOISE = /\[DBG:|Compiled in|✓ Compiled|Fast Refresh|\[HMR\]|Ready in|GET \/|POST \//;

function classify(line) {
  if (!line || NOISE.test(line)) return null;
  const body = line.replace(/^\[[^\]]*\]\s*/, ""); // 去掉 [HH:MM:SS]
  for (const r of RULES) {
    const m = body.match(r.re);
    if (m) return { id: r.id, sev: r.sev, icon: r.icon, label: r.label, text: r.fmt(m), ts: (line.match(/^\[([^\]]*)\]/) || [])[1] || "", raw: line };
  }
  return null;
}

// ---------------------------------------------------------------- 取日志
async function fetchLogs() {
  const res = await fetch(`${base}/api/translator/console-logs`, { headers: { cookie } });
  if (res.status === 401) {
    console.error("401 未授权 —— 会话密钥不对（换 --env / --secret）");
    process.exit(2);
  }
  if (!res.ok) {
    console.error(`HTTP ${res.status} ${base}/api/translator/console-logs`);
    process.exit(2);
  }
  const d = await res.json();
  return Array.isArray(d.logs) ? d.logs : [];
}

async function clearLogs() {
  await fetch(`${base}/api/translator/console-logs`, { method: "DELETE", headers: { cookie } });
}

// ---------------------------------------------------------------- 实时盯
async function watch(seconds) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), seconds * 1000);
  console.log(`盯 ${seconds} 秒…现在去发你的请求（Ctrl-C 提前结束）\n`);
  try {
    const res = await fetch(`${base}/api/translator/console-logs/stream`, { headers: { cookie }, signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop();
      for (const p of parts) {
        const raw = p.replace(/^data:\s*/, "");
        if (!raw) continue;
        let evt;
        try { evt = JSON.parse(raw); } catch { continue; }
        const lines = evt.type === "init" ? (evt.logs || []) : evt.type === "lines" ? evt.lines : evt.line ? [evt.line] : [];
        for (const l of lines) {
          const hit = classify(l);
          if (hit) console.log(`  ${hit.icon} [${hit.ts}] ${hit.label.padEnd(8)} ${hit.text}`);
        }
      }
    }
  } catch (e) {
    if (e.name !== "AbortError") throw e;
  } finally {
    clearTimeout(timer);
  }
  console.log("");
}

// ---------------------------------------------------------------- 主流程
if (flag("clear")) {
  await clearLogs();
  console.log(`已清空 ${base} 的日志缓冲。现在去发你的请求，然后跑：node ${path.relative(process.cwd(), process.argv[1])}\n`);
  process.exit(0);
}

if (watchSec > 0) {
  await watch(watchSec);
  process.exit(0);
}

const logs = await fetchLogs();
const events = logs.map(classify).filter(Boolean).reverse(); // 最新在前

if (wantJson) {
  console.log(JSON.stringify({ base, buffered: logs.length, events: events.slice(0, limit) }, null, 2));
  process.exit(0);
}

console.log("");
console.log(`探针  ${base}   缓冲 ${logs.length} 行   识别事件 ${events.length} 条`);
console.log("");

if (!events.length) {
  console.log("没有识别到任何路由事件。可能的解释：");
  console.log("  1. 缓冲已被冲掉（上限 200 行）——先 --clear 再发请求，然后立刻重跑");
  console.log("  2. 请求根本没进到路由层（改了端口、被前置代理/Cloudflare 拦掉、或打到了别的实例）");
  console.log("  3. 生产 LOG_LEVEL 太高，准入明细（available: N/M、逐账号锁）是 debug 级不输出");
  console.log("");
  process.exit(0);
}

console.log("=== 决策链（最新在前）===");
for (const e of events.slice(0, limit)) {
  console.log(`  ${e.icon} [${e.ts}] ${e.label.padEnd(10)} ${e.text}`);
}

// 结论：最近一次 gate 事件说了算
const firstGate = events.find((e) => e.sev === "gate");
const firstOk = events.find((e) => e.sev === "ok");
console.log("");
console.log("=== 结论 ===");
if (firstGate && (!firstOk || events.indexOf(firstGate) < events.indexOf(firstOk))) {
  console.log(`  ❌ 最近一次请求被「${firstGate.label}」挡下：[${firstGate.ts}] ${firstGate.text}`);
  console.log("     → 请求没有走到账号就被拒了，客户端会看到 429/503。");
} else if (firstOk) {
  console.log(`  ✅ 最近一次请求正常派发：[${firstOk.ts}] ${firstOk.text}`);
  console.log("     → 路由层是通的；如果客户端仍失败，问题在上游账号本身或出站网络。");
} else {
  console.log("  ⚠️ 只看到中间过程，没有结论性事件 —— 把 --clear 和发请求的时序再对齐一次。");
}

const counts = events.reduce((acc, e) => ((acc[e.id] = (acc[e.id] || 0) + 1), acc), {});
console.log("");
console.log("=== 事件统计 ===");
for (const [id, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  const meta = RULES.find((r) => r.id === id);
  console.log(`  ${meta.icon} ${meta.label.padEnd(12)} ×${n}`);
}
console.log("");
