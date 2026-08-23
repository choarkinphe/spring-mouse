# Changelog

本项目的公开发行记录从 `v0.1.0` 开始。此前的内部迭代记录、版本号和部署信息已从本文件移除。

## v0.1.0 — 2026-08-23

### 首次开源发布

- 以 Spring Mouse 名义发布首个公开版本。
- 公开 GitHub 仓库以 `main` 作为后续开发与发布分支。
- 移除内部 Jenkins 发布流水线；公开发布改由 GitHub Actions 驱动。

### AI 网关与路由

- 提供 OpenAI Chat Completions、Anthropic Messages 和 OpenAI Responses 兼容接口。
- 支持模型别名、自定义模型、模型禁用、可用性检测与流式响应转换。
- 支持多 Provider、多账号、优先级填充、账号轮询、故障跳过与自动回退。
- 支持回退、轮询和融合三种模型组合调度策略，并可配置时段和能力声明。

### 运营与访问控制

- 提供 API Key、调用方额度、5 小时/7 天 Token 窗口、访问来源与请求用量统计。
- 提供使用看板、趋势、成本、应用来源、Provider/模型排行和调用明细钻取。
- 支持管理员登录、TOTP 两步验证、IP 访问控制、上游代理与 Cloudflare Tunnel。

### 扩展能力

- 支持图像、视频、嵌入、语音、Web Search 和 Web Fetch 等媒体/网络能力。
- 集成 RTK Token Saver、Headroom、PxPipe、Translator、MITM/DNS 工具和控制台日志。
- 提供 Claude Code、Codex CLI、Cursor、Cline、Roo、Continue 及 OpenAI SDK 等集成文档。

### 容器与文档

- 提供 Docker Compose 一键部署模板，数据默认持久化到 `./data`。
- GitHub Actions 自动构建 `linux/amd64` 与 `linux/arm64` Docker 镜像；配置 Docker Hub Secrets 后会发布 `latest`、提交 SHA 和版本标签。
- 完善功能全景、Docker Hub 发布流程、部署说明和脱敏控制台截图。
