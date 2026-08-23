# Docker Hub 发布与 Docker Compose 部署

本项目通过 GitHub Actions 自动构建镜像并推送到 Docker Hub。你不需要在自己的电脑或服务器上安装 Docker build 环境来发布；只需完成一次账号配置，之后向 GitHub `main` 推送代码或版本标签即可自动发布。

默认镜像名：`choarkinphe/spring-mouse`。

## 一次性发布配置（只需做一次）

### 1. 创建 Docker Hub 公开仓库

登录 Docker Hub，创建：

```text
Namespace: choarkinphe
Repository: spring-mouse
Visibility: Public
```

最终镜像地址应为：

```text
choarkinphe/spring-mouse
```

### 2. 创建 Docker Hub Access Token

在 Docker Hub 的 **Account Settings → Personal access tokens** 中创建 Token：

- 名称可填写：`github-actions-spring-mouse`
- 权限至少选择 **Read & Write**
- 创建后立即复制 Token；Docker Hub 不会再次完整显示它。

不要把 Token 写入 `.env`、代码、README 或聊天记录。

### 3. 写入 GitHub Actions Secrets

打开 GitHub 仓库：**Settings → Secrets and variables → Actions → New repository secret**，依次创建：

| Secret 名称 | 值 |
|---|---|
| `DOCKERHUB_USERNAME` | `choarkinphe` |
| `DOCKERHUB_TOKEN` | 上一步创建的 Docker Hub Access Token |

仓库中的 `.github/workflows/docker-publish.yml` 会读取这两个 Secret。没有它们时，工作流会安全跳过镜像发布。

### 4. 触发首次构建

Secret 保存后，进入 GitHub 仓库的 **Actions**：

1. 选择 **Publish Docker image**；
2. 点击 **Run workflow**；
3. Branch 选择 `main`；
4. 点击绿色的 **Run workflow**；
5. 等待 job 完成。

工作流会构建并推送 `linux/amd64` 和 `linux/arm64` 两个架构的镜像。完成后可在 Docker Hub 的 Tags 页面看到：

```text
latest
sha-<commit-id>
```

## 发布版本标签

建议为稳定发布创建 Git 标签，例如：

```bash
git tag v0.1.0
git push origin v0.1.0
```

工作流会额外推送：

```text
choarkinphe/spring-mouse:v0.1.0
choarkinphe/spring-mouse:0.1
```

`latest` 始终跟随 GitHub `main` 的最新成功构建；生产环境建议在验证后固定使用版本标签。

## 使用者：Docker Compose 一键部署

### 首次部署

```bash
git clone https://github.com/choarkinphe/spring-mouse.git
cd spring-mouse
cp .env.example .env
```

编辑 `.env`，至少替换以下安全项：

```dotenv
JWT_SECRET=替换为长随机字符串
INITIAL_PASSWORD=设置管理员初始密码
API_KEY_SECRET=替换为稳定的长随机字符串
MACHINE_ID_SALT=替换为稳定的长随机字符串
```

可选：指定镜像版本。未设置时会使用 `latest`。

```dotenv
SPRING_MOUSE_IMAGE=choarkinphe/spring-mouse:latest
# 生产环境验证后建议固定版本，例如：
# SPRING_MOUSE_IMAGE=choarkinphe/spring-mouse:v0.1.0
```

然后执行：

```bash
docker compose pull
docker compose up -d
docker compose ps
```

访问地址：

```text
Dashboard: http://<服务器地址>:8008/dashboard
API:       http://<服务器地址>:8008/v1
Health:    http://<服务器地址>:8008/api/health
```

### 日常更新（你自己和使用者都一样）

```bash
cd spring-mouse
git pull
docker compose pull
docker compose up -d
docker image prune -f
```

如果部署固定版本，只需把 `.env` 中的 `SPRING_MOUSE_IMAGE` 改为新的版本号，再执行：

```bash
docker compose pull
docker compose up -d
```

### 回滚

将 `.env` 改回已验证的旧版本即可：

```dotenv
SPRING_MOUSE_IMAGE=choarkinphe/spring-mouse:v0.1.0
```

然后重新拉取并启动：

```bash
docker compose pull
docker compose up -d
```

## 发布者日常流程

```text
开发与测试
  → 合并/推送到 GitHub main
  → GitHub Actions 自动构建多架构镜像
  → Docker Hub 更新 latest 与 sha 标签
  → 服务器执行 docker compose pull && docker compose up -d
```

正式版本则额外推送 `vX.Y.Z` 标签，供生产服务器固定使用与回滚。

## 常见问题

### Actions 显示为 skipped

通常表示未配置 `DOCKERHUB_USERNAME` 或 `DOCKERHUB_TOKEN`。检查 Secret 名称是否完全一致，再在 Actions 中重新执行工作流。

### `docker compose pull` 显示 `pull access denied`

确认 Docker Hub 仓库已创建且可见性为 Public；还要确认 `SPRING_MOUSE_IMAGE` 与 Docker Hub namespace/repository 完全一致。

### ARM 或 x86 服务器无法启动

工作流会发布 `linux/amd64` 和 `linux/arm64`。在服务器执行：

```bash
docker manifest inspect choarkinphe/spring-mouse:latest
```

确认 manifest 中包含服务器的架构；若没有，查看对应 GitHub Actions 构建日志。
