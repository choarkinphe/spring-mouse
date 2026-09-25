#!/usr/bin/env bash
# 清理 spring-mouse 的 request-logs：只保留最近 N 分钟的会话目录，并兜底限制总量。
# 由宿主机 cron 每 5 分钟调用一次。
#   - 会话目录名形如 {source}_{target}_{model}_{YYYYMMDD_HHMMSS_mmm}
#   - 以目录 mtime 判定年龄（logger 会周期性 touch .active.json）
#   - 兜底：若总大小超过 MAX_MB，按最旧优先删除，直到降到阈值以下
set -uo pipefail

DIR=/www/docker/spring-mouse/data/request-logs
KEEP_MIN=${KEEP_MIN:-30}      # 保留最近多少分钟
MAX_MB=${MAX_MB:-512}         # 总大小上限（MB）
MIN_FREE_MB=${MIN_FREE_MB:-3000}  # 根分区可用空间下限（MB）；低于它就激进清理
LOG=/var/log/sm-requestlog-clean.log

[ -d "$DIR" ] || { echo "$(date '+%F %T') dir missing: $DIR" >> "$LOG"; exit 0; }

now=$(date +%s)
kept=0; removed=0
# 磁盘水位：可用空间低于下限时，把 MAX_MB 收紧到剩余空间的一半，
# 保证落盘永远不会把根分区写满（落盘是调试设施，不能挤垮生产）。
free_mb=$(df -Pm / | awk 'NR==2 {print $4}')
effective_max=$MAX_MB
if [ "${free_mb:-999999}" -lt "$MIN_FREE_MB" ]; then
  effective_max=$(( free_mb / 2 ))
  [ "$effective_max" -lt 100 ] && effective_max=100
fi

# 1) 按年龄清理（跳过正在写入的活跃会话：其 .active.json 的 mtime 很新）
while IFS= read -r d; do
  [ -z "$d" ] && continue
  # 活跃会话不删（logger 每 30s touch 一次 .active.json）
  if [ -f "$d/.active.json" ]; then
    age=$(( now - $(stat -c %Y "$d/.active.json") ))
    [ "$age" -lt 120 ] && { kept=$((kept+1)); continue; }
  fi
  m=$(stat -c %Y "$d" 2>/dev/null || echo "$now")
  if [ $(( now - m )) -gt $(( KEEP_MIN * 60 )) ]; then
    rm -rf "$d" && removed=$((removed+1))
  else
    kept=$((kept+1))
  fi
done < <(find "$DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null)

# 2) 兜底：总量超限则删最旧的（用 effective_max，受磁盘水位收紧）
total_mb=$(du -sm "$DIR" 2>/dev/null | awk '{print $1}')
if [ "${total_mb:-0}" -gt "$effective_max" ]; then
  while IFS= read -r d; do
    [ -z "$d" ] && continue
    if [ -f "$d/.active.json" ]; then
      age=$(( now - $(stat -c %Y "$d/.active.json") ))
      [ "$age" -lt 120 ] && continue
    fi
    rm -rf "$d"
    total_mb=$(du -sm "$DIR" 2>/dev/null | awk '{print $1}')
    [ "${total_mb:-0}" -le "$effective_max" ] && break
  done < <(find "$DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' 2>/dev/null | sort -n | awk '{print $2}')
fi

final_mb=$(du -sm "$DIR" 2>/dev/null | awk '{print $1}')
free_after=$(df -Pm / | awk 'NR==2 {print $4}')
echo "$(date '+%F %T') kept=$kept removed=$removed size=${final_mb}MB cap=${effective_max}MB free=${free_after}MB" >> "$LOG"

# 日志自身轮转（保留最近 2000 行）
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 4000 ]; then
  tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
