// 生产查询：所有时间戳统一以【东八区 CST】输出。
// 用法: node sm-query.js recent [N] | errors [N] | sql "<SQL>"
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/app/data/db/data.sqlite", { readOnly: true });
// DB 存 UTC ISO；展示统一转东八区。
const cst = (v) => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(v)) return v;
  try { return new Date(v).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }); } catch { return v; }
};

const [mode, arg] = process.argv.slice(2);
const N = Math.min(500, Math.max(1, parseInt(arg, 10) || 10));

if (mode === "recent") {
  const rows = db.prepare("SELECT timestamp, model, status, connectionId, data FROM requestDetails WHERE provider=? ORDER BY timestamp DESC LIMIT ?").all("codex", N);
  for (const r of rows) {
    let d = {}; try { d = JSON.parse(r.data); } catch {}
    const lat = d.latency || {};
    console.log(cst(r.timestamp) + "  " + String(r.model || "").padEnd(14) + "  " + String(r.status).padEnd(8) + "  ttft=" + String(lat.ttft ?? "-").padStart(7) + "  total=" + String(lat.total ?? "-").padStart(7));
  }
} else if (mode === "errors") {
  const rows = db.prepare("SELECT timestamp, provider, model, data FROM requestDetails WHERE status=? ORDER BY timestamp DESC LIMIT ?").all("error", N);
  if (!rows.length) console.log("(no errors)");
  for (const r of rows) {
    let d = {}; try { d = JSON.parse(r.data); } catch {}
    const e = typeof d.response?.error === "string" ? d.response.error : JSON.stringify(d.response?.error || "");
    console.log(cst(r.timestamp) + "  " + r.provider + "/" + r.model + "  " + e.replace(/\s+/g, " ").slice(0, 130));
  }
} else if (mode === "overload") {
  const rows = db.prepare("SELECT timestamp, provider, model, data FROM requestDetails WHERE status=? AND json_extract(data, ?) LIKE ? ORDER BY timestamp DESC LIMIT ?").all("error", "$.response.error", "%overloaded%", N);
  console.log("rows_failed_with_overload_text=" + rows.length);
  for (const r of rows) console.log("  " + cst(r.timestamp) + "  " + r.provider + "/" + r.model);
} else if (mode === "sql") {
  const rows = db.prepare(arg).all();
  for (const r of rows) {
    const o = {};
    for (const [k, v] of Object.entries(r)) o[k] = cst(v);
    console.log(JSON.stringify(o));
  }
} else {
  console.error("usage: sm-query.js recent [N] | errors [N] | overload [N] | sql \"<SQL>\"");
  process.exit(2);
}
