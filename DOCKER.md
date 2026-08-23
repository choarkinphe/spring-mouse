# Spring Mouse Docker 快速参考

完整的 Docker Hub 发布、首次部署、版本固定、升级和回滚请阅读 [docs/DOCKERHUB.md](docs/DOCKERHUB.md)。完整的部署、安全、反向代理、Jenkins 和故障排查请阅读 [DEPLOY.md](DEPLOY.md)。本页只保留常用 Docker 命令。

## 本地构建与运行

```bash
# 构建
DOCKER_BUILDKIT=1 docker build \
  --build-arg APP_BUILD_VERSION="$(git rev-parse --short=12 HEAD)" \
  -t choarkinphe/spring-mouse:local .

# 准备生产环境变量
cp .env.example .env
# 编辑 .env，替换所有 change-me 值

# 运行，并把数据持久化到宿主机
mkdir -p "$HOME/spring-mouse-data"
docker run -d \
  --name spring-mouse \
  --restart unless-stopped \
  --env-file .env \
  -e DATA_DIR=/app/data \
  -p 8008:8008 \
  -v "$HOME/spring-mouse-data:/app/data" \
  choarkinphe/spring-mouse:local
```

访问：

- Dashboard：`http://localhost:8008/dashboard`
- API：`http://localhost:8008/v1`
- 健康检查：`http://localhost:8008/api/health`

## 常用运维命令

```bash
# 日志
docker logs -f spring-mouse

# 健康与版本
curl -fsS http://127.0.0.1:8008/api/health
curl -fsS http://127.0.0.1:8008/api/version

# 停止、启动、移除
docker stop spring-mouse
docker start spring-mouse
docker rm -f spring-mouse
```

## Docker Compose

仓库的 `docker-compose.yml` 默认使用 Docker Hub 发布镜像 `choarkinphe/spring-mouse:latest`，并默认启动一个 Headroom sidecar。可在 `.env` 中用 `SPRING_MOUSE_IMAGE` 固定到具体版本标签。

```bash
cp .env.example .env
# 编辑 .env

docker compose pull
docker compose up -d
docker compose ps
docker compose logs -f spring-mouse
```

默认持久化目录：

```text
./data -> /app/data
```

其中 `data/db/data.sqlite` 是主数据库。升级、备份、外部 Headroom、Nginx 和 Cloudflare Tunnel 的配置见 [DEPLOY.md](DEPLOY.md)。

## Headroom

Compose 网络中的地址：

```dotenv
HEADROOM_URL=http://headroom:8787
```

不使用 Headroom 时，可以从实际部署 Compose 文件中移除 `headroom` 服务、依赖关系和 `HEADROOM_URL`，然后在 Dashboard → Token Saver 中关闭 Headroom。
