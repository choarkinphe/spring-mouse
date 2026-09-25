#!/usr/bin/env bash
# Spring Mouse 生产过载监控 —— 自包含脚本
# 位置: ~/.claude/scripts/sm-overload-monitor.sh （WSL 原生盘，持久）
# 被持久化定时任务调用。完整报告写入 $REPORT；stdout 只打印紧凑摘要，
# 以免长输出被 harness 折叠改写。
set -uo pipefail

HOST=192.168.86.72
SSH="ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 root@$HOST"
REPORT="$HOME/.claude/state/sm-overload-last.txt"
RAW=/tmp/sm-mon-remote.$$.sh
B64=/tmp/sm-mon.$$.b64
mkdir -p "$(dirname "$REPORT")"

# 单实例锁：定时巡检与手动调用可能并发，共享 /tmp/sm-mon-remote.sh 与 $REPORT 会
# 互相踩（一个进程删掉另一个正在读的临时文件 -> 报告被清成 0 字节）。
# 拿不到锁就等待，避免并发写坏报告。
LOCK="$HOME/.claude/state/.sm-monitor.lock"
exec 9>"$LOCK"
if ! flock -w 120 9; then
  echo '{"error":"another monitor run is in progress"}'
  exit 0
fi

# ---- 远端采集脚本 ----
cat > "$RAW" <<'REMOTE'
set -uo pipefail
# 时间基准说明（避免误读）：
#   - docker logs 的行首时间戳 [HH.MM.SS] 已是容器 TZ（Asia/Shanghai，东八区）
#   - DB 里 requestDetails.timestamp 存的是 UTC ISO（...Z）
# 本报告统一以【东八区 CST】呈现，并显式标注 UTC。
CST_NOW=$(TZ=Asia/Shanghai date '+%F %T')
UTC_NOW=$(date -u '+%F %T')
START_RAW=$(docker inspect spring-mouse --format '{{.State.StartedAt}}' 2>/dev/null || echo "?")
START_UTC="${START_RAW%%.*}Z"
START_CST=$(TZ=Asia/Shanghai date -d "$START_RAW" '+%F %T' 2>/dev/null || echo "?")
echo "NOW_CST=$CST_NOW  (UTC $UTC_NOW)"
echo "CONTAINER_STARTED_UTC=$START_UTC  (CST $START_CST)"
echo "NOTE=log lines are CST already; DB timestamps below are converted UTC->CST"
echo "=== 1. container ==="
docker inspect spring-mouse --format 'health={{.State.Health.Status}} restarts={{.RestartCount}}' 2>&1
curl -s -m 5 -o /dev/null -w 'api_health_http=%{http_code} time=%{time_total}s\n' http://127.0.0.1:8008/api/health 2>&1
echo "=== 2. overload retry counters (since boot) ==="
L=$(docker logs spring-mouse 2>&1 | sed -r 's/\x1b\[[0-9;]*[a-zA-Z]//g')
echo "retrying_within_budget=$(echo "$L" | grep -c 'retrying within a')"
echo "retry_lines=$(echo "$L" | grep -cE 'retry [0-9]+ in ')"
echo "recovered=$(echo "$L" | grep -c 'recovered after')"
echo "exhausted=$(echo "$L" | grep -c 'retries exhausted')"
# Third terminal path: the deadline ran out mid-scan, so the loop gave up and
# answered 503 without ever reaching the `retries exhausted` line. It is NOT an
# escape and NOT a recovery — counting it separately is what makes the arc
# identity below close. (Added 2026-09-26 after a real production arc landed here
# and left `retrying` permanently one ahead of `recovered + exhausted`.)
echo "spent_mid_scan=$(echo "$L" | grep -c 'spent mid-scan')"
echo "not_rotating=$(echo "$L" | grep -c 'not rotating accounts')"
echo "sse_overload=$(echo "$L" | grep -c 'sse_overload')"
echo "=== 3. retry arc, last 16m (log timestamps are CST) ==="
docker logs spring-mouse --since 16m 2>&1 | sed -r 's/\x1b\[[0-9;]*[a-zA-Z]//g' | grep -E 'RETRY' | tail -25
echo "=== 4. anomalies, last 16m (stack preserved; log timestamps are CST) ==="
docker logs spring-mouse --since 16m 2>&1 | sed -r 's/\x1b\[[0-9;]*[a-zA-Z]//g' \
  | grep -Ei 'error|fail|exception|fatal|ECONNRESET|aborted' \
  | grep -viE 'RequestDetail|errorStatus|usage_limit|no error|error handling' | tail -20
echo "=== 5. DB stats (since container start; all times shown in CST/东八区) ==="
START="$START_UTC" docker exec -e START="$START_UTC" -e TZ=Asia/Shanghai spring-mouse node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/app/data/db/data.sqlite", { readOnly: true });
const start = process.env.START;
// DB stores UTC ISO; render everything in CST so the report matches the container logs.
const cst = (iso) => { try { return new Date(iso).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }); } catch { return iso; } };
const q = (p,s) => db.prepare("SELECT COUNT(*) c FROM requestDetails WHERE provider=? AND status=? AND timestamp>?").get(p,s,start).c;
console.log("codex_success=" + q("codex","success") + " codex_error=" + q("codex","error"));
const slow = db.prepare("SELECT COUNT(*) c FROM requestDetails WHERE provider=? AND timestamp>? AND json_extract(data, ?) > 30000").get("codex", start, "$.latency.ttft").c;
console.log("codex_ttft_over_30s=" + slow);
console.log("all_provider_errors=" + db.prepare("SELECT COUNT(*) c FROM requestDetails WHERE status=? AND timestamp>?").get("error",start).c);
// NOTE on naming: this counts codex rows whose DB record carries the overload
// text. That is the EXPECTED outcome when the retry budget is exhausted (the
// gateway correctly returns 503). It is NOT the same as an escape — a true escape
// is the gateway forwarding the overload to the client as normal output, which is
// measured by dump_client_hits above. Read the two together: exhausted>0 with
// dump_client_hits=0 is healthy; dump_client_hits>0 is the real failure.
//
// TWO message shapes must both be matched (found 2026-09-26):
//   - "Our servers are currently overloaded. Please try again later." — the raw
//     upstream text, surfaced verbatim by the OLD escape path. Seeing this is the
//     historical failure mode.
//   - "Upstream overloaded" — the message the gateway synthesises when it gives
//     up on the budget itself (codexSseErrorResponse). This is the CURRENT,
//     CORRECT outcome.
// Matching only the first shape made this counter read 0 forever on the very
// exhaustion it was built to count — it lit up solely for pre-fix escapes.
const ov = db.prepare("SELECT COUNT(*) c FROM requestDetails WHERE provider=? AND timestamp>? AND status=? AND (json_extract(data, ?) LIKE ? OR json_extract(data, ?) LIKE ?)").get("codex", start, "error", "$.response.error", "%currently overloaded%", "$.response.error", "%Upstream overloaded%").c;
console.log("codex_db_overload_errors=" + ov + "  (budget-exhausted 503s; NOT an escape — see dump_client_hits)");
// 自启动以来的 codex 错误明细（CST），便于人工核对是否出现过载
const errs = db.prepare("SELECT timestamp, model, data FROM requestDetails WHERE provider=? AND status=? AND timestamp>? ORDER BY timestamp DESC LIMIT 10").all("codex","error",start);
console.log("-- codex errors since start (CST) --");
if (!errs.length) console.log("  (none)");
for (const r of errs) {
  let d = {}; try { d = JSON.parse(r.data); } catch {}
  const err = typeof d.response?.error === "string" ? d.response.error : JSON.stringify(d.response?.error || "");
  console.log("  " + cst(r.timestamp) + " " + r.model + " | " + err.replace(/\s+/g," ").slice(0,120));
}
// 最近 5 条 codex 请求（CST）
const recent = db.prepare("SELECT timestamp, model, status, json_extract(data, ?) ttft FROM requestDetails WHERE provider=? ORDER BY timestamp DESC LIMIT 5").all("$.latency.ttft","codex");
console.log("-- recent codex (CST) --");
for (const r of recent) console.log("  " + cst(r.timestamp) + " " + r.model + " " + r.status + " ttft=" + r.ttft);
' 2>&1 | grep -v Experimental
echo "=== 6. request-log dump scan (decides WHICH HOP produced the overload) ==="
echo "  # 5_res_provider.txt = upstream raw SSE; 7_res_client.txt = what the gateway sent the client."
echo "  # provider_hits>0 => upstream produced it (gateway retried, did not pass it on)"
echo "  # client_hits>0   => the gateway sent the overload text to the client (ESCAPE)"
# Dump health FIRST: the scan below is meaningless if dumps have silently stopped.
# This failed once (2026-09-25): settings.enableRequestLogFileDumps had been turned
# off in the DB and the process kept serving the cached value, so the dirs went
# stale and the escape check quietly had nothing to read.
DUMP_CFG=$(docker exec spring-mouse node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/app/data/db/data.sqlite", { readOnly: true });
const d = JSON.parse(db.prepare("SELECT data FROM settings WHERE id=1").get().data);
console.log(d.enableRequestLogFileDumps === true ? "on" : "off");
' 2>/dev/null | tail -1)
DUMP_NEWEST=$(docker exec spring-mouse sh -lc 'ls -1t /app/data/request-logs/ 2>/dev/null | head -1')
echo "dump_enabled=${DUMP_CFG:-unknown}"
echo "dump_newest=${DUMP_NEWEST:-EMPTY}"
if [ "$DUMP_CFG" = "off" ]; then
  echo "WARN: request-log dumps are DISABLED in settings — the escape check cannot see new traffic"
fi
if [ -z "$DUMP_NEWEST" ]; then
  echo "WARN: request-logs directory is EMPTY — dumps are not being written"
fi
docker exec spring-mouse sh /app/data/sm-tools/sm-scan-dumps.sh 2>&1 || echo "VERDICT=ERR"
REMOTE

$SSH "cat > $RAW && bash $RAW; rm -f $RAW" < "$RAW" 2>&1 | base64 -w0 > "$B64"
rm -f "$RAW"
base64 -d "$B64" 2>/dev/null | sed -r 's/\x1b\[[0-9;]*[a-zA-Z]//g' > "$REPORT"
rm -f "$B64"

# ---- 摘要：单行 JSON，避免被桥接层截断/折叠 ----
# 之前的 6 行摘要经常被调用方读不全（"输出不完整"），导致巡检反复重试。
# 一行 JSON 无歧义、无换行，调用方读一行即可判读；异常详情另存文件。
SUMMARY_FILE="$HOME/.claude/state/sm-overload-summary.json"
python3 - "$REPORT" "$SUMMARY_FILE" <<'PY' 2>/dev/null
import sys, json, re
report, out = sys.argv[1], sys.argv[2]
txt = open(report, encoding="utf-8", errors="replace").read()
def field(name, default=""):
    m = re.search(r"^" + re.escape(name) + r"=(\S*)", txt, re.M)
    return m.group(1).strip() if m else default
def rest(name, default=""):
    """Everything after `name=` on its line (for values that contain spaces)."""
    m = re.search(r"^" + re.escape(name) + r"=(.*)$", txt, re.M)
    return m.group(1).strip() if m else default
def kv(name, default=""):
    """First `name=value` anywhere in the report (handles values on shared lines)."""
    m = re.search(r"(?:^|\s)" + re.escape(name) + r"=(\S+)", txt, re.M)
    return m.group(1) if m else default
d = {
    "now_cst": rest("NOW_CST"),
    "health": rest("health"),
    "api_http": kv("api_health_http"),
    "retrying": field("retrying_within_budget"),
    "retry_lines": field("retry_lines"),
    "recovered": field("recovered"),
    "exhausted": field("exhausted"),
    "spent_mid_scan": field("spent_mid_scan"),
    "not_rotating": field("not_rotating"),
    "sse_overload": field("sse_overload"),
    "codex_success": kv("codex_success"),
    "codex_error": kv("codex_error"),
    "db_overload_errors": field("codex_db_overload_errors"),
    "dump_enabled": field("dump_enabled"),
    "dump_newest": field("dump_newest"),
    "dump_dirs": field("dump_dirs"),
    "dump_provider_hits": field("provider_hits"),
    "dump_client_hits": field("client_hits"),
    "verdict": field("VERDICT"),
    "report": report,
}
# Arc identity: every announced arc must terminate in exactly one way —
# recovered, exhausted, or spent_mid_scan. `arc_open` > 0 means an arc was still
# in flight at sample time (normal: the sampler can land 10s before a 120s budget
# expires) OR a new terminal path appeared that no counter covers. A value that
# stays > 0 across two consecutive samples is the latter — investigate.
try:
    _a = int(d["retrying"]); _b = int(d["recovered"]) + int(d["exhausted"]) + int(d["spent_mid_scan"])
    d["arc_open"] = str(_a - _b)
except Exception:
    d["arc_open"] = ""
json.dump(d, open(out, "w", encoding="utf-8"), ensure_ascii=False)
print(json.dumps(d, ensure_ascii=False))
PY
if [ ! -s "$SUMMARY_FILE" ]; then
  echo "{\"error\":\"summary generation failed\",\"report\":\"$REPORT\"}"
fi

# 异常详情（仅在需要时读）：截取第 3/4 段，另存一个文件
sed -n '/=== 3\./,/=== 5\./p' "$REPORT" 2>/dev/null | grep -v '^===' | head -20 > "$HOME/.claude/state/sm-overload-anomalies.txt" 2>/dev/null || true

# Exit status means "did the collection succeed", NOT "was anything wrong".
if [ -s "$REPORT" ] && grep -q '^=== 5\.' "$REPORT"; then
  exit 0
fi
echo "ERROR: collection failed — report missing or incomplete ($REPORT)" >&2
exit 1
