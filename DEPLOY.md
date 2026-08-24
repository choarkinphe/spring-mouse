# Spring Mouse 部署指南

本文档只描述当前 Spring Mouse 仓库中已有的部署与运行机制：Node.js 生产运行、Docker、Docker Compose、Nginx 反向代理、Headroom、Cloudflare Tunnel、GeoIP 与 Jenkins 发布流程。

> 生产 HTTP 端口是 **8008**；本地开发端口是 **8007**。不要把开发端口暴露到公网。

---

## 目录

- [部署前检查](#部署前检查)
- [环境变量](#环境变量)
- [Node.js 生产部署](#nodejs-生产部署)
- [Docker 单容器部署](#docker-单容器部署)
- [Docker Compose 部署](#docker-compose-部署)
- [数据持久化与备份](#数据持久化与备份)
- [Nginx 反向代理与 HTTPS](#nginx-反向代理与-https)
- [Headroom 与 PxPipe](#headroom-与-pxpipe)
- [Cloudflare Tunnel](#cloudflare-tunnel)
- [GeoIP](#geoip)
- [Jenkins 发布](#jenkins-发布)
- [升级、回滚与排查](#升级回滚与排查)

---

## 部署前检查

### 必要条件

| 项目 | 要求 |
|---|---|
| 运行时 | Node.js 22.5+（生产推荐 Node.js 22） |
| 数据库 | 无需外部数据库；应用使用 SQLite，Node 不可用时回退到 `sql.js` |
| 容器部署 | Docker Engine 与 Docker Compose v2 |
| 网络 | 对已配置的上游 Provider 保持出站访问；如需代理，配置 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` |
| 端口 | 本机或容器可监听 `8008`；使用 Nginx 时仅需让 Nginx 访问该端口 |

### 推荐的目录布局

```text
/opt/spring-mouse/
├── .env                  # 仅本机保存，不提交 Git
├── docker-compose.yml    # 部署配置
├── data/                 # SQLite、证书、日志、Tunnel 状态
└── geoip/                # 可选：MaxMind mmdb 文件
```

---

## 环境变量

从仓库模板开始：

```bash
cp .env.example .env
chmod 600 .env
```

### 必须设置的安全值

以下四项不能保留 `change-me`：

```dotenv
JWT_SECRET=<长度足够的随机字符串>
INITIAL_PASSWORD=<首次管理员密码>
API_KEY_SECRET=<稳定且不变的随机字符串>
MACHINE_ID_SALT=<稳定且不变的随机字符串>
```

生成随机字符串示例：

```bash
openssl rand -hex 32
```

`API_KEY_SECRET` 和 `MACHINE_ID_SALT` 一旦已用于生产数据，请不要随意变更；变更可能影响既有 Key 或机器身份派生结果。

### 必要运行配置

```dotenv
NODE_ENV=production
HOSTNAME=0.0.0.0
PORT=8008
DATA_DIR=/app/data

# 通过公网域名访问时替换为实际 HTTPS 地址
BASE_URL=https://mouse.example.com
NEXT_PUBLIC_BASE_URL=https://mouse.example.com
AUTH_COOKIE_SECURE=true

# 推荐生产环境开启
REQUIRE_API_KEY=true
# 完整请求/响应文件日志的首次启动默认值；部署后可在 Dashboard 设置页开关。
ENABLE_REQUEST_LOG_FILE_DUMPS=false
OBSERVABILITY_ENABLED=true
LOG_LEVEL=WARN
```

### 反向代理可信来源

Spring Mouse 只在 TCP 对端属于可信代理时接受 `X-Real-IP` 与 `X-Forwarded-For`。不要使用宽泛网段或 `0.0.0.0/0`。

```dotenv
# 例：Docker bridge 上的反向代理
TRUSTED_PROXY_IPS=172.18.0.0/16

# 例：独立 Nginx 主机
# TRUSTED_PROXY_IPS=10.10.0.15
```

### 可选集成

```dotenv
# Headroom sidecar 或外部地址
HEADROOM_URL=http://headroom:8787

# 自建 SearXNG 搜索端点
SEARXNG_URL=http://searxng:8080/search

# GeoIP 文件路径
GEOIP_DATA_DIR=/app/data/geoip
GEOIP_CITY_PATH=/app/data/geoip/GeoLite2-City.mmdb
GEOIP_ASN_PATH=/app/data/geoip/GeoLite2-ASN.mmdb

# 上游网络代理（按需启用）
# HTTP_PROXY=http://127.0.0.1:7890
# HTTPS_PROXY=http://127.0.0.1:7890
# ALL_PROXY=socks5://127.0.0.1:7890
# NO_PROXY=localhost,127.0.0.1,::1
```

---

## Node.js 生产部署

适用于不使用容器的单机或受控服务器。

```bash
git clone git@git.wiguo.cn:service/spring-mouse.git
cd spring-mouse

npm install
cp .env.example .env
# 编辑 .env

npm run build
npm run start
```

服务启动后：

```bash
curl -fsS http://127.0.0.1:8008/api/health
curl -fsS http://127.0.0.1:8008/api/version
```

生产入口是 `custom-server.js`。它在 Next.js 服务外层处理可信代理地址、真实客户端 IP 标记和后台 Token 刷新任务，因此不要用 `next start` 替代 `npm run start`。

### 使用 systemd（示例）

创建 `/etc/systemd/system/spring-mouse.service`：

```ini
[Unit]
Description=Spring Mouse AI Gateway
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/spring-mouse
EnvironmentFile=/opt/spring-mouse/.env
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

启用并查看状态：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now spring-mouse
sudo systemctl status spring-mouse
journalctl -u spring-mouse -f
```

---

## Docker 单容器部署

### 构建镜像

在仓库根目录执行：

```bash
docker build \
  --build-arg APP_BUILD_VERSION="$(git rev-parse --short=12 HEAD)" \
  -t spring-mouse:local .
```

镜像使用多阶段构建，包含：

- Next.js standalone 产物；
- `open-sse` 与 MITM 所需文件；
- SQLite 的 `sql.js` 回退文件；
- `cloudflared` 二进制；
- 运行时数据目录 `/app/data`。

### 运行容器

```bash
mkdir -p "$HOME/spring-mouse-data"

# 使用 .env，避免把密钥暴露在 shell history 中
docker run -d \
  --name spring-mouse \
  --restart unless-stopped \
  --env-file .env \
  -e DATA_DIR=/app/data \
  -p 8008:8008 \
  -v "$HOME/spring-mouse-data:/app/data" \
  spring-mouse:local
```

检查：

```bash
docker logs -f spring-mouse
docker exec spring-mouse cat /app/build-info.json
curl -fsS http://127.0.0.1:8008/api/health
```

如果容器需要访问宿主机运行的 Headroom：

- macOS / Windows：`HEADROOM_URL=http://host.docker.internal:8787`
- Linux：增加 `--add-host=host.docker.internal:host-gateway`，再使用同一地址。

---

## Docker Compose 部署

仓库的 `docker-compose.yml` 是内部生产镜像模板：

- Spring Mouse 镜像：`docker.wiguo.cn/spring-mouse:latest`
- 对外端口：`8008`
- 数据挂载：`./data:/app/data`
- GeoIP 挂载：`/www/geoip:/app/data/geoip`
- 可选 Headroom 服务：`ghcr.io/chopratejas/headroom:latest`

### 启动

```bash
cp .env.example .env
# 编辑 .env，替换全部安全值

docker compose pull
docker compose up -d

docker compose ps
docker compose logs -f spring-mouse
```

### 健康检查

Compose 为 Spring Mouse 定义了健康检查：

```bash
docker compose exec spring-mouse wget -qO- http://127.0.0.1:8008/api/health
curl -fsS http://127.0.0.1:8008/api/version
```

### 不需要 Headroom 时

当前仓库模板默认包含 Headroom。如果不需要，可从部署服务器实际使用的 Compose 文件中移除：

- `headroom` service；
- `spring-mouse.depends_on.headroom`；
- `HEADROOM_URL=http://headroom:8787`。

然后在 Dashboard 的 Token Saver 设置中保持 Headroom 关闭。

---

## 数据持久化与备份

### 数据目录

生产容器把应用数据写入 `DATA_DIR`；推荐始终挂载 `/app/data`。其中通常包括：

```text
/app/data/
├── db/
│   └── data.sqlite          # 主数据库：通道、策略、Key、设置、用量等
├── mitm/                    # 根证书、MITM 运行状态和 DNS 配置
├── tunnel/                  # Cloudflare Tunnel 运行状态
├── geoip/                   # 可选 MaxMind 数据
└── ...                      # 日志、导出和运行时文件
```

### 备份 SQLite

停止写入窗口后备份最稳妥：

```bash
docker compose stop spring-mouse
cp data/db/data.sqlite "backup/data-$(date +%F-%H%M%S).sqlite"
docker compose start spring-mouse
```

对于持续运行的生产环境，建议：

- 定期备份整个 `data/` 目录；
- 将备份存入独立存储；
- 恢复前先停止服务；
- 恢复后核对 `/api/health`、`/api/version` 和 Dashboard 中的通道数量。

> 请求明细与 Provider 凭据可能包含敏感数据。备份必须按生产密钥材料同等级别保护。

---

## Nginx 反向代理与 HTTPS

建议仅开放 Nginx 的 80/443 端口，并把 Spring Mouse 的 8008 限制在本机或私有网络。

```nginx
server {
    listen 80;
    server_name mouse.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name mouse.example.com;

    ssl_certificate     /etc/letsencrypt/live/mouse.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mouse.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8008;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 长连接与 SSE
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

对应 `.env`：

```dotenv
BASE_URL=https://mouse.example.com
NEXT_PUBLIC_BASE_URL=https://mouse.example.com
AUTH_COOKIE_SECURE=true
TRUSTED_PROXY_IPS=127.0.0.1
```

如果 Nginx 运行在其他容器或机器上，`TRUSTED_PROXY_IPS` 必须写实际 TCP 对端的 IP/CIDR，而不是客户端网段。

---

## Headroom 与 PxPipe

### Headroom

Headroom 是可选的外部处理服务。它不决定 Spring Mouse 是否可启动；未启用时，网关仍可正常提供模型路由。

1. 在网络可达的位置启动 Headroom；
2. 设置 `HEADROOM_URL`；
3. Dashboard → **Token Saver** 中检查连通性后启用；
4. 通过用量与日志观察处理效果。

容器内 sidecar 地址：

```dotenv
HEADROOM_URL=http://headroom:8787
```

### PxPipe

PxPipe 由 Dashboard 管理，可进行安装、启动、停止、重启、状态查询、统计与日志查看。其配置项包括：

```dotenv
# 这些值也可在控制台中管理
# PXPIPE 由应用按设置自动安装或加载
```

启用前应先在测试请求中验证：大请求处理是否符合团队的时延和内容保留要求。

---

## Cloudflare Tunnel

生产镜像内已携带 `cloudflared`。管理员可以在 Dashboard → **个人与系统设置** 中：

1. 保存 Cloudflare Tunnel Token；
2. 启动或停止 Tunnel；
3. 查看当前公开地址与运行状态。

服务进程启动时会立即按已保存的启用状态拉起 Tunnel；如果 Docker 刚重启、网络或 Cloudflare Edge 尚未就绪导致 `cloudflared` 未启动，服务会以 **3 秒、6 秒、12 秒、24 秒、之后每 30 秒** 的退避节奏持续重试。Tunnel 已运行时每 15 秒检查一次；停止 Tunnel 会同时停止该自动恢复机制。

建议：

- Tunnel 仅暴露必要路径；
- 开启 `REQUIRE_API_KEY=true`；
- Dashboard 仍通过登录保护；
- 对外访问时使用 HTTPS 与可信域名；
- 定期检查 Tunnel Token 权限和撤销状态。

不要把 Cloudflare Tunnel 当作绕过访问控制的方式。

---

## GeoIP

GeoIP 为用量分析补充国家、地区、城市、时区和 ASN（取决于安装的数据文件）。

1. 获取 MaxMind GeoLite2 数据库；
2. 挂载目录到 `/app/data/geoip`；
3. 配置 `.env`：

```dotenv
GEOIP_DATA_DIR=/app/data/geoip
GEOIP_CITY_PATH=/app/data/geoip/GeoLite2-City.mmdb
GEOIP_ASN_PATH=/app/data/geoip/GeoLite2-ASN.mmdb
```

没有 GeoIP 文件时，应用仍可正常运行，只是不展示相关地理信息。

---

## Jenkins 发布

仓库 `Jenkinsfile` 实现内部镜像的构建和部署流程：

1. 拉取指定 Git 分支；
2. 读取短 commit SHA，并以 `APP_BUILD_VERSION` 注入镜像；
3. 构建、检查并推送 `docker.wiguo.cn/spring-mouse:latest`；
4. SSH 到目标服务器，通过 Compose 更新服务；
5. 轮询 `/api/health`；
6. 验证 `/api/version` 返回 `currentVersion`；
7. 对比容器镜像 ID、OCI revision label 与容器内 `/app/build-info.json`；
8. 清理 Jenkins 节点上的悬空镜像。

Jenkins 参数：

| 参数 | 作用 |
|---|---|
| `DEPLOY_TARGET` | 目标服务器配置。 |
| `GIT_BRANCH` | 要构建/部署的分支。 |
| `ONLY_BUILD` | 仅构建并推送镜像，不更新服务器。 |
| `NO_CACHE_BUILD` | 禁用 Docker 构建缓存。 |

部署服务器上的 `.env` 与 `docker-compose.yml` 是运维配置权威；不要依赖 CI 覆盖其中的密钥或环境差异。

---

## 升级、回滚与排查

### 升级

```bash
docker compose pull
docker compose up -d

docker compose ps
curl -fsS http://127.0.0.1:8008/api/health
curl -fsS http://127.0.0.1:8008/api/version
```

升级前先备份 `data/`。升级后进入 Dashboard 检查通道、路由策略、API Key 和最近请求是否正常。

### 回滚

- 部署前保留可用镜像的 digest 或版本 tag；
- 将 Compose 的 image 改回对应版本；
- `docker compose up -d`；
- 仅在必要时恢复数据库备份，因为新旧版本的数据库迁移可能不同。

### 常见问题

| 现象 | 检查方式 |
|---|---|
| 容器反复重启 | `docker compose logs --tail=200 spring-mouse`；检查 `.env`、挂载目录权限和端口占用。 |
| Dashboard 打不开 | `curl http://127.0.0.1:8008/api/health`；检查 Nginx upstream、容器端口映射。 |
| 登录 Cookie 无效 | 检查 `BASE_URL`、`NEXT_PUBLIC_BASE_URL` 和 `AUTH_COOKIE_SECURE` 是否与 HTTPS 状态一致。 |
| 真实客户端 IP 不对 | 检查 Nginx 是否传递真实 IP 头，以及 `TRUSTED_PROXY_IPS` 是否匹配代理 TCP 对端。 |
| 上游请求失败 | Dashboard 检查通道认证、账号状态、模型可用性、配额和上游代理。 |
| 某策略未按预期选模型 | 检查候选模型时段、能力要求、策略模式、通道账号可用性和请求日志。 |
| Headroom 不可用 | 检查 `HEADROOM_URL` 在 Spring Mouse 容器网络中的可达性，再在 Token Saver 页面测试。 |
| 数据库无法打开 | 检查 `data/db/data.sqlite` 所在目录权限、磁盘空间和容器挂载配置。 |

---

## 相关文档

- [项目说明与路由策略](README.md)
- [技术架构](docs/ARCHITECTURE.md)
- [Docker 快速参考](DOCKER.md)
