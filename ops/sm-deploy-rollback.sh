#!/bin/sh
# ============================================================================
#  spring-mouse 生产备份 / 部署 / 回滚  一体化脚本
# ----------------------------------------------------------------------------
#  在【生产主机】上运行（root@192.168.86.72），工作目录 /www/docker/spring-mouse。
#
#  用法：
#    sh sm-deploy-rollback.sh backup              只做备份（部署前跑）
#    sh sm-deploy-rollback.sh deploy <REV>        备份 → 拉取 latest → 起容器
#    sh sm-deploy-rollback.sh rollback            回滚【功能】到备份时的镜像
#    sh sm-deploy-rollback.sh rollback-db         回滚【数据库】到备份时的快照
#    sh sm-deploy-rollback.sh rollback-all        功能和数据库一起回滚
#    sh sm-deploy-rollback.sh list                列出已有备份
#    sh sm-deploy-rollback.sh verify              健康检查 + 冒烟
#
#  设计要点（重要，别改坏）：
#
#  1) 【功能回滚】用本地保存的镜像 tag，不依赖 Docker Hub。
#     `latest` 是可变的：如果线上出问题，你 pull 回来的可能还是坏的那个。
#     所以备份时把当前镜像钉成 spring-mouse:pre-<REV>-<时间戳>，回滚直接
#     用这个本地 tag 起容器，永不 pull。这就是"可随时回退功能"的保证。
#
#  2) 【数据库回滚】用 sqlite3 .backup 而不是 cp。
#     库在跑（WAL 模式），cp 出来的是撕裂的快照。.backup 走 SQLite 的在线
#     备份 API，得到一个自洽的库。备份时容器可以继续服务。
#
#  3) 迁移是【向前、跳版本安全】的（src/lib/db/migrate.js）：旧镜像遇到
#     schemaVersion 更高时只是跳过迁移，不会报错。但 024 建了两张新表，
#     旧镜像不认识——留着无害。所以回滚功能【不需要】回滚数据库；
#     回滚数据库只在数据真的被写坏时才用，且必须同时回滚功能。
#
#  4) 回滚数据库会丢掉备份点之后的所有数据（用量、账号状态、设置）。
#     脚本会二次确认。
#
#  5) 环境变量：SPRING_MOUSE_IMAGE 覆盖镜像名；SM_DIR 覆盖部署目录。
# ============================================================================
set -eu

SM_DIR="${SM_DIR:-/www/docker/spring-mouse}"
IMAGE="${SPRING_MOUSE_IMAGE:-choarkinphe/spring-mouse:latest}"
BACKUP_ROOT="${SM_DIR}/.sm-backups"
CONTAINER="spring-mouse"
HEALTH_URL="http://127.0.0.1:8008/api/health"

# compose 命令：优先 v2 插件，回落 v1
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
else
  DC="docker-compose"
fi

log()  { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

require_root() {
  [ "$(id -u)" = "0" ] || die "请用 root 运行（容器与 bind-mount 文件属主是 root/choarkinphe）"
}

# 当前容器使用的镜像 ID（可能带 sha256: 前缀）
current_image_id() {
  docker inspect "$CONTAINER" --format '{{.Image}}' 2>/dev/null || true
}
current_rev() {
  docker inspect "$CONTAINER" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || echo "unknown"
}
db_file() { echo "${SM_DIR}/data/db/data.sqlite"; }

# ── 备份 ────────────────────────────────────────────────────────────────────
do_backup() {
  require_root
  local ts rev imgid dir
  # 快照约等于库大小（现在 ~2GB）。低于 4GB 可用空间就拒绝，别把磁盘写满——
  # 生产磁盘写满会连带打挂 SQLite 写入与 Redis AOF。
  local free_mb
  free_mb="$(df -Pm "$SM_DIR" | awk 'NR==2{print $4}')"
  if [ -n "$free_mb" ] && [ "$free_mb" -lt 4096 ]; then
    die "可用空间仅 ${free_mb}MB，低于 4096MB，拒绝备份以免写满磁盘（先清理 .sm-backups 或旧镜像）"
  fi
  ts="$(date '+%Y%m%d-%H%M%S')"
  rev="$(current_rev)"
  imgid="$(current_image_id)"
  [ -n "$imgid" ] || die "找不到容器 ${CONTAINER} 的镜像，无法备份"

  dir="${BACKUP_ROOT}/${ts}-${rev}"
  mkdir -p "$dir"
  log "备份目录：$dir"

  # 1) 把当前运行的镜像钉成本地 tag —— 回滚的唯一依赖
  log "钉住当前镜像 ${imgid} → spring-mouse:pre-${rev}-${ts}"
  docker tag "$imgid" "spring-mouse:pre-${rev}-${ts}"

  # 2) 记录部署现场（可精确复现当时的容器配置）
  docker inspect "$CONTAINER" > "${dir}/container-inspect.json" 2>/dev/null || true
  docker image inspect "$imgid" > "${dir}/image-inspect.json" 2>/dev/null || true
  printf '%s\n' "spring-mouse:pre-${rev}-${ts}" > "${dir}/rollback-image.txt"
  printf '%s\n' "$rev" > "${dir}/revision.txt"
  printf '%s\n' "$imgid" > "${dir}/image-id.txt"
  cp -a "${SM_DIR}/docker-compose.yml" "${dir}/docker-compose.yml" 2>/dev/null || true
  cp -a "${SM_DIR}/.env" "${dir}/.env" 2>/dev/null || true

  # 3) 数据库一致性快照（容器可继续服务）
  local dbf; dbf="$(db_file)"
  if [ -f "$dbf" ]; then
    log "在线备份数据库（sqlite3 .backup）…"
    if sqlite3 "$dbf" ".backup '${dir}/data.sqlite'"; then
      log "数据库快照：$(du -h "${dir}/data.sqlite" | cut -f1)"
    else
      # 兜底：容器里没有 sqlite3 时，主机有就用主机的；都失败则报错但不阻断部署
      log "警告：sqlite3 .backup 失败，尝试只读复制（可能不一致）"
      cp -a "$dbf" "${dir}/data.sqlite.inconsistent" || true
    fi
    # 记录 schemaVersion，便于回滚前核对
    sqlite3 "$dbf" "SELECT value FROM _meta WHERE key='schemaVersion';" > "${dir}/schema-version.txt" 2>/dev/null || true
    sqlite3 "$dbf" "SELECT value FROM _meta WHERE key='backupSchemaVersion';" > "${dir}/backup-schema-version.txt" 2>/dev/null || true
  else
    log "警告：找不到数据库 ${dbf}"
  fi

  log "备份完成。"
  prune_backups
  cat <<EOF

  ┌────────────────────────────────────────────────────────────────┐
  │ 备份内容                                                        │
  ├────────────────────────────────────────────────────────────────┤
  │ 目录        : $dir
  │ 镜像 tag    : spring-mouse:pre-${rev}-${ts}
  │ 数据库      : ${dir}/data.sqlite
  │ revision    : ${rev}
  │ 镜像 ID     : ${imgid}
  └────────────────────────────────────────────────────────────────┘

  回滚功能 : sh $0 rollback      回退到【上一次部署】的版本（deploy 时记录）
  回滚数据 : sh $0 rollback-db   回退数据库到最新快照
  （要回退到指定备份：SM_BACKUP_DIR=<备份目录> sh $0 rollback）

EOF
}

latest_backup_dir() {
  [ -d "$BACKUP_ROOT" ] || die "没有任何备份（$BACKUP_ROOT 不存在）"
  ls -1dt "${BACKUP_ROOT}"/*/ 2>/dev/null | head -1 | sed 's:/$::'
}

# 每份快照约 2GB，不设上限会把磁盘吃满——这正是 request-logs 清理脚本踩过的坑
# （见 ops/README.md：上限贴着稳态时它会一直删，最后连活跃目录一起删掉）。
# 默认只保留最近 2 份：足够"回滚一次 + 留一个已知良好点"，且不会失控。
# 被删的备份会连它独有的镜像 tag 一起清掉，避免本地 tag 无限堆积。
prune_backups() {
  local keep="${SM_BACKUP_KEEP:-2}"
  local all n i d live tags t
  all="$(ls -1dt "${BACKUP_ROOT}"/*/ 2>/dev/null || true)"
  [ -n "$all" ] || return 0

  # 1) 目录：只留最近 keep 份
  n="$(printf '%s\n' "$all" | wc -l | tr -d ' ')"
  if [ "$n" -gt "$keep" ]; then
    i=0
    printf '%s\n' "$all" | while IFS= read -r d; do
      d="${d%/}"
      i=$((i+1))
      [ "$i" -le "$keep" ] && continue
      log "清理旧备份（保留最近 ${keep} 份）：$(basename "$d")"
      rm -rf "$d"
    done
  fi

  # 2) 镜像 tag：把不再被任何【保留中】备份引用的 pre-* 清掉。
  #    用存活备份的 rollback-image.txt 做白名单，逐行精确匹配——
  #    比"在目录里 grep 这个 tag"可靠（后者受 grep 语义与子 shell 影响，
  #    实测漏删过孤立 tag）。
  live="$(cat "${BACKUP_ROOT}"/*/rollback-image.txt 2>/dev/null || true)"
  tags="$(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -E '^spring-mouse:pre-' || true)"
  [ -n "$tags" ] || return 0
  printf '%s\n' "$tags" | while IFS= read -r t; do
    [ -n "$t" ] || continue
    if ! printf '%s\n' "$live" | grep -qxF "$t"; then
      log "清理孤立镜像 tag：$t"
      docker rmi "$t" >/dev/null 2>&1 || true
    fi
  done
}

resolve_backup_dir() {
  if [ -n "${SM_BACKUP_DIR:-}" ]; then
    [ -d "$SM_BACKUP_DIR" ] || die "SM_BACKUP_DIR 不存在：$SM_BACKUP_DIR"
    printf '%s\n' "$SM_BACKUP_DIR"
  else
    latest_backup_dir
  fi
}

# ── 回滚功能 ────────────────────────────────────────────────────────────────
do_rollback() {
  require_root
  local dir tag label
  # 优先用 deploy 记下的"上一次部署版本"——这才是用户想退回去的那个。
  # 退回"最新备份"只在没有 previous 记录时作为兜底。
  if [ -n "${SM_BACKUP_DIR:-}" ]; then
    dir="$SM_BACKUP_DIR"
    [ -d "$dir" ] || die "SM_BACKUP_DIR 不存在：$dir"
    tag="$(cat "${dir}/rollback-image.txt" 2>/dev/null || true)"
    label="备份 ${dir}"
  elif [ -f "${BACKUP_ROOT}/previous-image.txt" ]; then
    tag="$(cat "${BACKUP_ROOT}/previous-image.txt")"
    label="上一次部署（$(cat "${BACKUP_ROOT}/previous-revision.txt" 2>/dev/null || echo '?')）"
  else
    dir="$(resolve_backup_dir)"
    tag="$(cat "${dir}/rollback-image.txt" 2>/dev/null || true)"
    label="最新备份 ${dir}"
  fi

  [ -n "$tag" ] || die "找不到可回滚的镜像 tag"
  docker image inspect "$tag" >/dev/null 2>&1 || die "本地镜像 tag 不存在：$tag（可能被清理了）"

  log "回滚【功能】→ ${tag}"
  log "  目标：${label}"
  log "  当前：$(current_rev)"

  # 把本地 tag 重新指回 latest，然后 up -d（compose 用 latest，不会去 pull）
  docker tag "$tag" "$IMAGE"
  ( cd "$SM_DIR" && $DC up -d --no-deps "$CONTAINER" )
  log "容器已用回滚镜像重启。"

  # 迁移是向前兼容的：不主动回滚数据库。仅提示。
  local schema_now
  schema_now="$(sqlite3 "$(db_file)" "SELECT value FROM _meta WHERE key='schemaVersion';" 2>/dev/null || echo '?')"
  log "当前数据库 schemaVersion=${schema_now}（回滚功能不动它；新表留着无害）"
  do_verify
}

# ── 回滚数据库 ──────────────────────────────────────────────────────────────
do_rollback_db() {
  require_root
  local dir snap
  dir="$(resolve_backup_dir)"
  snap="${dir}/data.sqlite"
  [ -f "$snap" ] || die "备份 ${dir} 里没有 data.sqlite 快照"

  printf '\n'
  printf '!! 回滚数据库会丢弃该备份点之后写入的全部数据（用量/账号状态/设置）。\n'
  printf '   备份点时间戳：%s\n' "$(basename "$dir")"
  printf '   快照大小    ：%s\n' "$(du -h "$snap" | cut -f1)"
  printf '   输入 yes 继续：'
  read -r ans
  [ "$ans" = "yes" ] || die "已取消"

  local dbf; dbf="$(db_file)"
  log "停止容器（确保没有连接在写库）…"
  ( cd "$SM_DIR" && $DC stop "$CONTAINER" ) || true

  # 把回滚前的库再存一份，万一回滚错了还能回来
  local safety="${dir}/pre-rollback-$(date '+%Y%m%d-%H%M%S').sqlite"
  log "回滚前先自保一份：$safety"
  [ -f "$dbf" ] && sqlite3 "$dbf" ".backup '${safety}'" 2>/dev/null || true

  log "恢复快照到 $dbf"
  rm -f "${dbf}-wal" "${dbf}-shm"
  cp -a "$snap" "$dbf"
  chown choarkinphe:choarkinphe "$dbf" 2>/dev/null || true

  log "启动容器…"
  ( cd "$SM_DIR" && $DC up -d --no-deps "$CONTAINER" )
  do_verify
}

do_rollback_all() {
  # 先功能后数据：旧镜像 + 旧库才是完全一致的一个现场
  do_rollback
  do_rollback_db
}

# ── 健康检查 / 冒烟 ─────────────────────────────────────────────────────────
do_verify() {
  local i=0
  printf '\n'
  log "等待健康检查…"
  while [ $i -lt 40 ]; do
    local h
    h="$(docker inspect "$CONTAINER" --format '{{.State.Health.Status}}' 2>/dev/null || echo '?')"
    if [ "$h" = "healthy" ]; then break; fi
    if [ "$h" = "unhealthy" ]; then log "容器 unhealthy，仍继续观察"; fi
    i=$((i+1)); sleep 3
  done
  log "容器状态：$(docker inspect "$CONTAINER" --format '{{.State.Status}} / {{.State.Health.Status}}' 2>/dev/null)"

  # HTTP 健康端点
  if command -v curl >/dev/null 2>&1; then
    log "GET ${HEALTH_URL}"
    curl -fsS --max-time 5 "$HEALTH_URL" && printf '\n' || log "健康端点无响应（见上面）"
  fi

  # 冒烟：真实发一条最小 chat 请求，确认不再 500。
  # 这是本次修复的回归点——observer 接口错了会在这里 500。
  #
  # 关键：用真实 API key。只用无 key 请求的话，路由层会在鉴权处直接 401
  # 返回，根本走不到被修的代码路径——"健康检查通过但聊天全 500"正是这么
  # 漏过去的。key 来源：SM_SMOKE_KEY 环境变量，否则从库里取一个活跃 key。
  local key model
  key="${SM_SMOKE_KEY:-}"
  if [ -z "$key" ]; then
    key="$(sqlite3 "$(db_file)" "SELECT key FROM apiKeys WHERE isActive=1 ORDER BY lastUsedAt DESC LIMIT 1;" 2>/dev/null || true)"
  fi
  model="${SM_SMOKE_MODEL:-gpt-6-astra}"

  log "冒烟测试：POST /v1/chat/completions（model=${model}，$( [ -n "$key" ] && echo '带 key' || echo '无 key'))"
  if command -v curl >/dev/null 2>&1; then
    local code
    code="$(curl -s -o /tmp/sm-smoke.json -w '%{http_code}' --max-time 60 \
      -X POST "http://127.0.0.1:8008/v1/chat/completions" \
      -H 'Content-Type: application/json' \
      ${key:+-H "Authorization: Bearer ${key}"} \
      -d "{\"model\":\"${model}\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":1,\"stream\":false}" 2>/dev/null || echo '000')"
    log "HTTP ${code}"
    head -c 400 /tmp/sm-smoke.json 2>/dev/null; printf '\n'
    case "$code" in
      200) log "冒烟通过（200）：请求走通了完整链路" ;;
      500) log "!! 500：应用内部抛错，正是本脚本要防的回归。回滚：sh $0 rollback" ;;
      401|403)
        if [ -n "$key" ]; then
          log "!! 带 key 仍 ${code}：鉴权异常，请人工确认"
        else
          log "无 key 被鉴权拦截（${code}）——只证明进程活着，未覆盖业务路径。"
          log "   要真正验证，请设 SM_SMOKE_KEY=<key> 再跑 verify"
        fi
        ;;
      000) log "!! 连不上（000）：容器可能还没起来" ;;
      *) log "非 200（${code}）：多为上游/模型名/额度问题；看上面 body 判断，若为应用错误则应回滚" ;;
    esac
  fi

  log "近 5 分钟容器错误日志（若有）："
  docker logs --since 5m "$CONTAINER" 2>&1 | grep -iE 'error|typeerror|is not a function' | tail -15 || true
}

# ── 部署（备份 → pull → 起） ────────────────────────────────────────────────
do_deploy() {
  require_root
  local want="${1:-}"
  # 记录"上一次部署的版本"，让 rollback 有一个稳定、直觉的目标。
  # 只靠"最新一份备份"是不对的：如果部署后又跑过 backup（比如为了留档），
  # 最新备份就成了【新】版本，rollback 会退化成空操作。所以部署前把当前
  # 运行中的镜像钉成 spring-mouse:previous 并记下 revision。
  local prev_rev prev_id
  prev_rev="$(current_rev)"
  prev_id="$(current_image_id)"
  if [ -n "$prev_id" ]; then
    docker tag "$prev_id" "spring-mouse:previous" 2>/dev/null || true
    mkdir -p "$BACKUP_ROOT"
    printf '%s\n' "spring-mouse:previous" > "$BACKUP_ROOT/previous-image.txt"
    printf '%s\n' "$prev_rev" > "$BACKUP_ROOT/previous-revision.txt"
    log "记录上一次部署版本：${prev_rev} → spring-mouse:previous"
  fi

  do_backup
  log "拉取最新镜像…"
  ( cd "$SM_DIR" && $DC pull "$CONTAINER" )
  log "起容器…"
  ( cd "$SM_DIR" && $DC up -d --no-deps "$CONTAINER" )
  log "部署完成。期望 revision=${want:-latest}"
  do_verify
  log "当前 revision：$(current_rev)"
  log "如需回退本次部署：sh $0 rollback"
}

do_list() {
  require_root
  [ -d "$BACKUP_ROOT" ] || die "没有任何备份"
  printf '备份目录：%s（合计 %s）\n\n' "$BACKUP_ROOT" "$(du -sh "$BACKUP_ROOT" 2>/dev/null | cut -f1)"
  printf '磁盘：%s\n\n' "$(df -h "$SM_DIR" | tail -1)"
  for d in $(ls -1dt "${BACKUP_ROOT}"/*/ 2>/dev/null); do
    d="${d%/}"
    printf '%s\n' "$(basename "$d")"
    printf '   revision : %s\n' "$(cat "$d/revision.txt" 2>/dev/null || echo '?')"
    printf '   image tag: %s\n' "$(cat "$d/rollback-image.txt" 2>/dev/null || echo '?')"
    printf '   db       : %s\n' "$([ -f "$d/data.sqlite" ] && du -h "$d/data.sqlite" | cut -f1 || echo '（无）')"
  done
  printf '\n本地镜像 tag：\n'
  docker images --format '  {{.Repository}}:{{.Tag}}  {{.CreatedSince}}' | grep -E 'spring-mouse:pre-|rollback-' || true
}

case "${1:-}" in
  backup)        do_backup ;;
  deploy)        shift; do_deploy "${1:-}" ;;
  rollback)      do_rollback ;;
  rollback-db)   do_rollback_db ;;
  rollback-all)  do_rollback_all ;;
  list)          do_list ;;
  verify)        do_verify ;;
  *)
    cat <<EOF
用法: sh $0 {backup|deploy <REV>|rollback|rollback-db|rollback-all|list|verify}

  backup        备份当前镜像（本地 tag）+ 数据库一致性快照
  deploy <REV>  备份 → pull latest → 起容器 → 健康检查+冒烟
  rollback      回滚【功能】到上一次部署的镜像（本地 tag，不 pull）
  rollback-db   回滚【数据库】到最新备份的快照（需输入 yes 确认）
  rollback-all  功能+数据库一起回滚
  list          列出备份与本地镜像 tag
  verify        健康检查 + 真实请求冒烟

  环境变量:
    SM_DIR=<dir>            部署目录（默认 $SM_DIR）
    SPRING_MOUSE_IMAGE=<img> 镜像名（默认 $IMAGE）
    SM_BACKUP_DIR=<dir>     指定回滚到某份备份（默认最新）
EOF
    ;;
esac
