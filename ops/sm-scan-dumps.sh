#!/bin/sh
# 扫描 request-log 落盘目录，判定「超载文案」出自哪一跳，并给出精确时间。
#
# 只认「SSE 错误帧」的结构，而非短语本身 —— 调试对话的回复里也会引用
# "Our servers are currently overloaded"（本会话走同一网关），单纯 grep 短语
# 会产生大量假阳性。
#
# 判读：
#   - 仅 5_res_provider.txt 命中 => 上游产生（网关重试了，未透传）
#   - 7_res_client.txt 命中      => 网关把该文案发给了客户端（逃逸）
#
# 目录名格式: {source}_{target}_{model}_{YYYYMMDD_HHMMSS_mmm}  (本地/东八区)
DUMPS=${1:-/app/data/request-logs}
LIMIT=${2:-200}
hits5=0
hits7=0
dirs=$(ls -1 "$DUMPS" 2>/dev/null | wc -l)
echo "dump_dirs=$dirs"

for dir in $(ls -1t "$DUMPS" 2>/dev/null | head -"$LIMIT"); do
  # 从目录名提取时间戳（东八区）: ..._20260925_000033_100
  ts=$(echo "$dir" | sed -n 's/.*_\([0-9]\{8\}\)_\([0-9]\{6\}\)_[0-9]*$/\1 \2/p')
  ts_fmt=$(echo "$ts" | awk '{ if (NF==2) printf "%s-%s-%s %s:%s:%s", substr($1,1,4), substr($1,5,2), substr($1,7,2), substr($2,1,2), substr($2,3,2), substr($2,5,2) }')
  for f in 5_res_provider.txt 7_res_client.txt; do
    p="$DUMPS/$dir/$f"
    [ -f "$p" ] || continue
    if grep -q '"code":"server_is_overloaded"' "$p" 2>/dev/null \
       || grep -q '"code": "server_is_overloaded"' "$p" 2>/dev/null \
       || grep -q '"code":"service_unavailable"' "$p" 2>/dev/null; then
      if [ "$f" = "5_res_provider.txt" ]; then hits5=$((hits5+1)); else hits7=$((hits7+1)); fi
      echo "HIT $f  cst=$ts_fmt  $dir"
    fi
  done
done
echo "provider_hits=$hits5"
echo "client_hits=$hits7"
# 判读提示：client_hits>0 表示有请求把过载文案发给了客户端
if [ "$hits7" -gt 0 ]; then echo "VERDICT=ESCAPE (gateway passed overload to client)"; \
elif [ "$hits5" -gt 0 ]; then echo "VERDICT=UPSTREAM_ONLY (gateway retried, did not pass it on)"; \
else echo "VERDICT=CLEAN (no overload frames in dumps)"; fi
