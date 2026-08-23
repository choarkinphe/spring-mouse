# Spring Mouse 功能全景

Spring Mouse 是面向团队和个人的 AI 网关与运营控制台：将多个模型渠道、账号、媒体服务和调用方统一接入，在一个兼容 API 与 Dashboard 下完成路由、配额、观测和运维。

> 本文以当前代码实现为准。各模型、配额和媒体能力是否可用，取决于你实际配置的 Provider、账号权限及其上游服务状态。

## 1. 统一 API 网关

| 能力 | 说明 |
|---|---|
| OpenAI Chat Completions | `POST /v1/chat/completions`，支持流式与非流式调用。 |
| Anthropic Messages | `POST /v1/messages`，包含 Token 计数端点。 |
| OpenAI Responses | `POST /v1/responses` 与请求压缩端点。 |
| 模型发现 | 模型列表、模型详情、按类型查询、模型别名、自定义模型、禁用模型和可用性测试。 |
| 多模态 API | 嵌入、图像生成、视频生成/编辑/查询、语音合成、语音转写、音色查询、Web Search 与 Web Fetch。 |
| 协议与流转换 | 在不同客户端协议、上游格式与 SSE 流式响应间做适配和转换。 |

所有对外兼容接口以 `/v1` 为根路径；具体可调用模型由渠道配置与路由策略决定。

## 2. 渠道、Provider 与账号管理

- 在 **渠道管理** 中统一创建、编辑、启停和检测 Provider。
- 支持 OAuth、PAT、API Key、Cookie/Token 导入，以及 OpenAI/Anthropic 兼容节点等接入形式；不同 Provider 可用的认证方式不同。
- 一个 Provider 可配置多个账号连接，支持优先级填充或账号轮询。
- 出现认证失效、限流、模型不可用或连接锁定时，路由会跳过不可用连接并继续尝试候选通道。
- 可查看连接状态、已启用连接数、模型数量、余额或周期配额，并按需刷新。
- 支持通道模型测试、模型别名、自定义模型、模型禁用与模型可用性检查。

## 3. 模型组合与路由策略

路由策略把一个对外模型名映射为一个或多个内部模型节点，支持：

| 调度方式 | 使用场景 |
|---|---|
| **回退** | 按顺序调用候选节点；失败时自动尝试下一个。 |
| **轮询** | 在可用候选节点间均匀分摊请求。 |
| **融合** | 并行调用多个候选模型，再由裁判模型汇总结果；质量优先，但会增加调用次数。 |

每个节点还可配置优先级、启用状态、时段生效规则和能力声明。能力声明可表示图像输入、推理/思考、上下文窗口等条件，用于避免把不兼容请求路由到不适合的模型。

## 4. 调用方、凭据与额度控制

- 创建、命名、启用、禁用和删除 API Key。
- 支持决定兼容 API 是否必须携带 API Key。
- 每个 Key 可设置不受限、受限或关闭等额度模式。
- 受限 Key 会统计 **5 小时** 与 **近 7 天** Token 窗口，支持按时间滚动重置和在 Dashboard 中手动重置。
- 记录 API Key、来源 IP、客户端 User-Agent、模型、请求结果和 Token，用于区分不同调用方与排查问题。
- 支持 IP 访问控制、管理员登录保护与 TOTP 两步验证。

## 5. 用量、成本与运营看板

Dashboard 提供实时运营视图：

- 服务运行时间、版本、CPU、内存、请求数、输入/缓存/输出 Token 与预估成本；
- Provider、模型、调用方、来源、时间范围等维度的趋势和排行分析；
- 请求详情、原始请求日志与实时 SSE 用量推送；
- 通道额度概览、刷新及排序；
- 人员与活跃度辅助报告，可辅助观察调用频次、Token 规模、连续性与成功率。

> 人员分析仅适合作为运营观察信号，不应单独作为绩效或业务贡献结论。

## 6. Token 与请求处理管道

| 组件 | 当前能力 |
|---|---|
| RTK Token Saver | 压缩冗余上下文与工具输出，降低 Token 占用。 |
| Headroom | 可使用 Compose sidecar 或外部地址；支持健康检查、连接状态与本地启停。 |
| PxPipe | 可安装、启动、停止、重启，查看状态、统计与日志。 |
| Translator | 保存/读取翻译配置、发起翻译请求、查看控制台日志。 |

这些能力可按需启用；未启用时不会影响基础模型网关调用。

## 7. 媒体、知识与网络服务

媒体服务中心按能力分组统一管理 Provider：

- **生成能力**：图像生成、视频生成、视频编辑和延展；
- **语音能力**：TTS、语音转写、可用音色查询；
- **知识能力**：文本嵌入及相关服务；
- **网络能力**：Web Search 与 Web Fetch。

可接入第三方 API、自建兼容服务、TTS/STT 服务或 OpenAI/Anthropic 兼容节点。每一项能力显示接入状态，且独立于文本对话 Provider 管理。

## 8. 客户端与 SDK 集成

可将 Spring Mouse 作为兼容 API Endpoint 接入：

- Claude Code、OpenAI Codex CLI、Cursor、Cline、Roo、Continue；
- OpenAI SDK、Node.js、Python、LangChain、LlamaIndex；
- Postman、Insomnia、curl 和其他支持 OpenAI/Anthropic 兼容 API 的工具。

仓库在 `gitbook/content/zh-CN/integration/` 下提供了各客户端的逐步配置文档。

## 9. 远程访问、代理与本地工具

- **Cloudflare Tunnel**：在 Dashboard 保存 Tunnel Token，启动/停止 Tunnel 并查看公开地址。
- **上游代理**：支持 HTTP、HTTPS、SOCKS 与 `NO_PROXY` 配置。
- **MITM / DNS 工具**：针对受支持客户端进行流量拦截和重定向；使用前需要理解根证书、管理员权限与网络安全影响。
- **基础对话与控制台日志**：用于验证配置、查看运行日志和辅助调试。

## 10. 数据、安全与运行方式

- 使用本地 SQLite 数据库存储配置、密钥、用量和运营数据；`./data` 挂载为持久化目录。
- 通过 `.env` 管理初始管理员密码、JWT 密钥、API Key 密钥、机器标识盐值及可选 OAuth 配置；`.env` 不应提交到 Git。
- 支持本地开发、Node.js 生产构建、Docker Compose 和 Docker Hub 镜像部署。
- Docker 镜像同时构建 `linux/amd64` 与 `linux/arm64`，兼容常见云服务器与 ARM 主机。

## 11. 控制台功能地图

| Dashboard 区域 | 包含的核心功能 |
|---|---|
| 首页 | 服务运行状态、请求/Token/成本、最近请求、响应 Provider、通道额度。 |
| 渠道管理 | Provider、认证连接、账号轮询、模型、额度、模型测试。 |
| 媒体服务 | 图像、视频、语音、嵌入、搜索、抓取能力的 Provider 配置。 |
| 路由策略 | 组合、候选节点、时段、回退/轮询/融合、能力声明。 |
| 使用看板 | 趋势、明细、排行、来源/调用方与实时用量。 |
| 集成与凭据 | API Key、Endpoint、调用方额度与访问控制。 |
| 设置 | 管理员认证、TOTP、数据库、代理、Tunnel、可观测性和系统配置。 |
| 开发工具 | Token Saver、翻译器、PxPipe、基础对话、控制台日志。 |

## 12. 功能截图

以下截图来自本地演示环境；请求明细已做脱敏处理：

![Dashboard overview](../public/screenshots/dashboard-overview.png)

### 使用看板：趋势与成本

![Usage analytics](../public/screenshots/usage-analytics.png)

### 使用看板：调用明细钻取

![Usage drill-down](../public/screenshots/usage-details.png)

### 路由策略

![Routing policies](../public/screenshots/routing-policies.png)

### 媒体服务

![Media services](../public/screenshots/media-services.png)
