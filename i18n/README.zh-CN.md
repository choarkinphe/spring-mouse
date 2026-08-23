<div align="center">

# 🐭 Spring Mouse

**AI 模型路由网关 · 协议翻译器 · Token 节省器 · 实时用量分析**

将 Claude Code、Codex、Cursor、Cline、OpenClaw、Antigravity 等 AI 编程工具统一接入一个 OpenAI/Claude 兼容端点，自动在 40+ 上游 Provider、100+ 模型之间智能路由，并通过 RTK Token Saver 压缩工具输出，降低 20–40% token 消耗。

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

---

## 📖 目录

- [🤔 为什么用 Spring Mouse](#-为什么用-spring-mouse)
- [🔄 工作原理](#-工作原理)
- [✨ 核心功能](#-核心功能)
- [⚡ 快速开始](#-快速开始)
- [🔌 接入你的 AI 工具](#-接入你的-ai-工具)
- [🛠️ 技术栈](#️-技术栈)
- [📁 项目结构](#-项目结构)
- [📝 API 参考](#-api-参考)
- [🐛 常见问题](#-常见问题)
- [📚 部署文档](#-部署文档)
- [🙏 致谢](#-致谢)
- [📄 许可](#-许可)

---

## 🤔 为什么用 Spring Mouse

**传统 AI 工具直连单一 Provider 的痛点：**

- ❌ 订阅配额月底清零，经常剩一半没用
- ❌ 速率限制/额度耗尽时直接中断编码
- ❌ `git diff`、`grep`、目录列表等工具输出吃掉大量 token
- ❌ 多账号/多 Provider 需要手动切来切去
- ❌ 不同工具要分别配置 Claude / OpenAI / Gemini 接口

**Spring Mouse 的解决方式：**

- ✅ **统一端点**：所有工具指向同一个 `http://localhost:8008/v1`
- ✅ **智能路由**：按能力、配额、价格、时段自动选择模型
- ✅ **组合模型（Combos）**：自定义 fallback 链，如 `cc/claude-opus → glm/glm-5 → kr/sonnet`
- ✅ **RTK Token Saver**：自动压缩 tool_result 与输出，节省 20–40% token
- ✅ **多账号轮询**：同一 Provider 配置多个账号，自动 round-robin
- ✅ **协议翻译**：OpenAI ↔ Claude ↔ Kiro ↔ Cursor ↔ Gemini ↔ Ollama ↔ Vertex 自动互转
- ✅ **实时用量分析**：Dashboard 展示请求、token、配额、用户、来源、节省量
- ✅ **API Key 配额**：为不同 key 设置 token 配额与组合模型白名单

---

## 🔄 工作原理

```
┌──────────────────────────────────────────────────────────────┐
│  你的 AI 工具                                                 │
│  Claude Code / Codex / Cursor / Cline / OpenClaw / Antigravity │
└──────────────────┬─────────────────────────────────────────────┘
                   │ OpenAI-compatible API
                   │ http://localhost:8008/v1
                   ↓
┌──────────────────────────────────────────────────────────────┐
│                    Spring Mouse 路由网关                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ 协议翻译器    │  │  能力/配额    │  │   RTK Token      │   │
│  │ OpenAI↔Claude │  │  路由决策     │  │   Saver 压缩      │   │
│  └──────────────┘  └──────────────┘  └──────────────────┘   │
└──────────────────┬───────────────────────────────────────────┘
                   │
       ┌───────────┼───────────┐
       ↓           ↓           ↓
┌──────────┐ ┌──────────┐ ┌────────────┐
│ 订阅模型  │ │ 低价模型  │ │ 免费模型    │
│ cc/ gh/  │ │ glm/     │ │ kr/ oc/    │
│ cx/ cu/   │ │ minimax/ │ │ vertex/    │
└──────────┘ └──────────┘ └────────────┘
```

### 模型命名空间

| 前缀 | Provider | 类型 |
|---|---|---|
| `cc/` | Claude Code | 订阅 |
| `cx/` | Codex | 订阅 |
| `cu/` | Cursor | 订阅 |
| `gh/` | GitHub Copilot | 订阅 |
| `glm/` | 智谱 GLM | 低价（约 $0.6/1M） |
| `minimax/` | MiniMax | 低价（约 $0.2/1M） |
| `kimi/` | Kimi / Moonshot | 订阅 |
| `kr/` | Kiro AI | 免费额度 |
| `oc/` | OpenCode Free | 免费免登录 |
| `vertex/` | Vertex AI | 免费额度 |

> 组合模型可以跨前缀串联：`cc/claude-opus-4-7 → glm/glm-5.1 → kr/claude-sonnet-4-5`。

### RTK Token Saver 流程

```
AI 工具发送 tool_result ──→ RTK 压缩工具输出
                              去除冗余 diff / 列表结构
                              ↓
                         请求上游模型
                              ↓
                         模型返回响应
                              ↓
                         Caveman/Ponytail 风格精简输出
                              ↓
                         返回给 AI 工具
```

效果：
- 输入 token 减少 20–40%（基于 RTK 压缩）
- 输出 token 进一步减少（基于 Caveman / Ponytail 风格精简）

---

## ✨ 核心功能

### 1. OpenAI / Claude 兼容网关

- `POST /v1/chat/completions`
- `POST /v1/messages`（Anthropic Messages API）
- `POST /v1/responses`（OpenAI Responses API）
- `POST /v1/embeddings`
- `POST /v1/images/generations`
- `POST /v1/videos/generations` / `edits`
- `POST /v1/audio/speech` / `transcriptions`
- `POST /v1/web/fetch`（联网搜索）
- `GET  /v1/models` / `[kind]` / `info`

> 工具只需配置一个 Endpoint：`http://localhost:8008/v1`

### 2. 智能路由与组合模型

- **组合能力声明**：每个组合独立声明上下文窗口、vision / audio；声明输入能力时必须包含至少一个可承接该能力的组合内模型。
- **配额耗尽自动回退**：优先使用订阅模型，配额用尽后回落到低价/免费模型。
- **多账号轮询**：同一 Provider 可配置多个账号，自动 round-robin。
- **按时段调度**：组合模型可按时间段选择不同上游（例如工作时间用 `cc/`，夜间用 `glm/`）。
- **Combo-only routing**：API Key 可限制只能访问指定的组合模型。

### 3. RTK Token Saver

- 自动压缩 `tool_result` 内容。
- 支持 Headroom 旁路代理进行额外反检测/压缩处理。
- Dashboard 中可开关并配置 Headroom URL。
- 实时展示压缩前后字节数与节省百分比。

### 4. 用量、配额与计费

- **实时 Dashboard**：`http://localhost:8008/dashboard`
- **SSE 流**：`GET /api/usage/stream` 实时推送统计。
- **多维度分析**：按 Provider、模型、用户、来源、时间窗口聚合。
- **配额窗口**：支持 5 小时窗口与周窗口独立重置。
- **API Key 配额**：为 key 设置 token 配额与定时重置计划。
- **请求日志**：可选开启 `ENABLE_REQUEST_LOGS=true`，包含来源 IP、UA、模型、token 数等。

### 5. Provider 连接管理

- 40+ Provider，包括 Claude Code、Codex、Cursor、Kiro、OpenCode、GLM、MiniMax、Kimi、Vertex、GitHub Copilot、Gemini、Ollama、Qoder、TokenRouter、Fish Audio 等。
- 支持 OAuth 2.0 PKCE、PAT、API Key 三种连接方式。
- 支持 Self-hosted STT / TTS / Embedding Provider。
- 支持批量测试 Provider 与模型可用性。

### 6. 认证与安全

| 功能 | 说明 |
|---|---|
| JWT 登录 | 初始密码通过 `INITIAL_PASSWORD` 配置 |
| API Key | 自动生成 Default Key，支持滚动配额 |
| OAuth 2.0 PKCE | Kiro / Cursor / Codex / GitLab / iFlow 等 |
| SAML 2.0 SSO | 支持 AuthnRequest、ACS、SP Metadata |
| 本地路径保护 | `custom-server.js` 使用 peer-token 防止远程冒充本地 |
| 可信代理 | `TRUSTED_PROXY_IPS` 配置反向代理 |
| 请求详情脱敏 | `/api/usage/request-details` 红敏 payload |
| GeoIP | 可选 MaxMind GeoLite2，识别用户地理位置 |

### 7. CLI 与工具链

- `cli/cli.js`：启动、后台运行、托盘、端口、更新检查、进程管理。
- `setup-cli/`：独立安装 CLI。
- 支持 `spring-mouse` 全局命令。

---

## ⚡ 快速开始

### 方式一：源码运行

```bash
# 1. 克隆仓库
git clone git@git.wiguo.cn:service/spring-mouse.git
cd spring-mouse

# 2. 安装依赖
npm install

# 3. 复制环境变量模板
cp .env.example .env
# 编辑 .env：至少替换 JWT_SECRET、INITIAL_PASSWORD、API_KEY_SECRET、MACHINE_ID_SALT

# 4. 启动开发服务器（端口 8007）
npm run dev

# 5. 打开 Dashboard
open http://localhost:8008
```

> 开发服务器跑在 8007，生产构建后跑在 8008。详见 `.env.example` 注释。

### 方式二：Docker 运行

```bash
# 使用项目内置 docker-compose.yml
cp .env.example .env
# 编辑 .env 后

docker compose up -d
```

详细部署说明见 [DEPLOY.md](../DEPLOY.md)。

---

## 🔌 接入你的 AI 工具

以 Claude Code / Codex / Cursor / Cline 为例：

```
Endpoint: http://localhost:8008/v1
API Key:  [从 Dashboard → Endpoint 复制]
Model:    cc/claude-opus-4-6
```

也可以直接使用组合模型：

```
Model: combo/my-smart-fallback
```

组合模型在 Dashboard → Combos 中配置，例如：

```
cc/claude-opus-4-7  →  glm/glm-5.1  →  kr/claude-sonnet-4.5
```

当第一个模型配额耗尽或失败时，自动回退到下一个。

---

## 🛠️ 技术栈

| 层级 | 技术 |
|---|---|
| Runtime | Node.js 22 |
| 主框架 | Next.js 16 |
| UI | React 19 + Tailwind CSS 4 |
| 数据库 | SQLite（better-sqlite3 / node:sqlite / sql.js fallback） |
| 流式 | Server-Sent Events |
| 认证 | JWT + OAuth 2.0 PKCE + SAML 2.0 |
| 代理 | Express + http-proxy-middleware |
| 部署 | Docker + Jenkins + cloudflared |

---

## 📁 项目结构

```text
spring-mouse/
├── cli/                    # 全局 CLI、托盘、构建脚本
├── open-sse/               # 路由核心：翻译器、执行器、Provider、RTK、服务
├── src/                    # Next.js 应用源码
├── custom-server.js        # 生产入口：Express + Next.js
├── docker-compose.yml      # 生产 compose 模板
└── DEPLOY.md               # 部署文档
```

---

## 📝 API 参考

### Chat Completions

```bash
POST http://localhost:8008/v1/chat/completions
Authorization: Bearer your-api-key
Content-Type: application/json

{
  "model": "cc/claude-opus-4-6",
  "messages": [
    {"role": "user", "content": "Write a function to..."}
  ],
  "stream": true
}
```

### List Models

```bash
GET http://localhost:8008/v1/models
Authorization: Bearer your-api-key
```

返回所有可用模型 + 组合模型，格式与 OpenAI `/v1/models` 一致。

---

## 🐛 常见问题

**"Language model did not provide messages"**

- Provider 配额耗尽 → 查看 Dashboard Quota 面板
- 解决方案：切换到组合模型中的低价/免费层级

**速率限制**

- 订阅模型配额用完 → 自动 fallback 到 glm/minimax
- 手动添加 combo：`cc/claude-opus-4-7 → glm/glm-5.1 → kr/claude-sonnet-4-5`

**OAuth token 过期**

- Spring Mouse 会自动刷新
- 若仍失败：Dashboard → Provider → Reconnect

**成本高**

- 开启 RTK Token Saver：Dashboard → Endpoint → Token Saver（默认开启）
- 把非关键任务交给 glm/minimax/oc 等低价/免费模型

**Dashboard 端口不对**

- 开发：`http://localhost:8007`
- 生产/Docker：`http://localhost:8008`

**首次登录失败**

- 检查 `.env` 中的 `INITIAL_PASSWORD`
- 未设置时回退密码为 `123456`

**看不到请求日志**

- 设置 `ENABLE_REQUEST_LOGS=true` 并重启

---

## 📚 部署文档

详细的 Docker、Jenkins、反向代理、Headroom 旁路配置见 [DEPLOY.md](../DEPLOY.md)。

---

## 🙏 致谢

Spring Mouse 的灵感来源于社区中优秀的 AI 路由与 Token 节省项目。特别感谢：

- **[Spring Mouse](https://github.com/decolua/spring-mouse)** — 一个充满创意的 AI 路由与 Token 节省网关，本项目在产品形态与核心思路（多 Provider 路由、RTK 压缩、Token 统计）上深受其启发，并沿用并增强了其中相当一部分架构设计。
- **[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)** — 最初的 Go 实现，启发了多 Provider 代理的思路。
- **[RTK](https://github.com/rtk-ai/rtk)** — Rust token-saver，Spring Mouse 将其压缩流程移植到 JS / Dashboard 中。
- **[Caveman](https://github.com/JuliusBrussee/caveman)** by [@JuliusBrussee](https://github.com/JuliusBrussee) — "why use many token when few token do trick"
- **[Ponytail](https://github.com/DietrichGebert/ponytail)** by [@DietrichGebert](https://github.com/DietrichGebert) — "lazy senior dev" skill

如果这些项目对你有帮助，欢迎也给他们点一颗 ⭐。

---

## 📄 许可

MIT License — 详见 [LICENSE](../LICENSE)。

---

<div align="center">
  <sub>Built with ❤️ for developers who code 24/7</sub>
</div>
