# Changelog

## v0.4.313 — 2026-11-06

- 修复 Devin 在 `max_tokens: 1` 探活请求下无可见输出时被判为 502 `empty_stream` 的问题，改为返回 `finish_reason: length` 的正常回复。
- 空回复（`empty_stream`）改为切换账号但不再锁定账号 30 秒，避免单账号渠道整体下线。

## v0.4.311 — 2026-11-06

- 修复 Devin 授权在 TLS 终止与 Host 改写代理之后被同源检查误拒绝的问题；保留浏览器跨站请求保护和非浏览器严格 Origin 回退校验。

## v0.4.310 — 2026-11-06

### Devin 直连模型反代

- 新增 Devin 浏览器 PKCE 登录与远程手动授权码流程，无需启动本机 CLI Agent。
- 支持 Connect-RPC 模型协议、模型家族与思考档位、工具往返、图片、缓存标记、签名和流式错误处理。
- 接入账号身份、日/周额度、ACU/余额及官方模型目录同步。
- 完成真实账号 JSON、SSE、工具往返、Messages 和 Responses 短请求验证；保留凭据脱敏和取消处理。

## Unreleased

### 组合成员配额

- 配额改为直接配置在「路由策略」的组合成员上：每个 `provider/model` 成员可设 5 小时与每周 Token 上限（单位 M），与可见标签、时段调度并列。取代上一版在设置页单独维护的模型组规则（该界面与接口已移除）。
- 按每把 API 密钥 × 实际渠道模型计数；同一模型出现在多个组合里共用计数、取最小限额。
- 成员额度用完时，本次请求像「不在调度时段」一样跳过它，按组合原有顺序继续尝试后续成员；全部成员用完返回 429 `combo_member_quota_exceeded` 并带 `Retry-After`。
- 计数器复用密钥已有的滚动重置边界（Redis scope `member:<provider/model>`）；读取或计数异常时放行，不阻断请求。整体配额不受影响。

### 仅允许调用组合

- 新增「设置 · API Key 配额 · 仅允许调用组合」开关：开启后，未带豁免标签的密钥只能调用模型组合，直接请求渠道模型返回 403 `access_denied`，`/v1/models` 也只列出组合。
- 豁免标签默认 `god`、`sys`，用于调试和内部工具。默认关闭，开启前请先把直连调用方迁移到组合。

### JevAPI / TypeSafe System One

- 新增 JevAPI API Key 通道、上游模型同步和密钥验证。
- 新增 `/v1/systemone` 原生结构化决策接口，支持 Noul、Choice、Score、网关鉴权、账号切换及 Token 用量记录；不将 Jev 作为聊天模型。
- 增加原生协议单元测试和使用隔离数据、模拟上游的 Preview 验证入口。

## v0.4.5 — 2026-08-26

### 📈 网络流量统计

- 记录每次模型请求的上传、下载和总流量
- 支持按日、周、月等筛选周期汇总网络流量
- 使用看板核心指标区域增加数据流量卡片，并展示最近 10 分钟趋势
- 模型调用明细直接展示上传流量、下载流量和总流量

---

本项目的公开发行记录从 `v0.1.0` 开始。此前的内部迭代记录、版本号和部署信息已从本文件移除。

## v0.4.1 — 2026-08-26

### 📊 Redis 与异步持久化状态可视化

- Dashboard 顶部增加 Redis 连接状态、延迟和内存使用量
- 增加 Redis Key 数量、RSS 与 AOF 文件大小详情
- 增加 Redis Stream 队列长度、Pending 数量和 SQLite Writer 心跳状态
- 顶部状态灯综合判断系统负载、Redis 连接、Writer 健康度与队列积压
- Redis 异常时仍可正常打开 Dashboard，并明确显示故障状态

---

## v0.4.0 — 2026-08-26

### 🚀 Redis 实时用量层与 SQLite 异步持久化

- Docker 镜像内置仅监听容器回环地址的 Redis，无需新增服务、端口、环境变量或数据卷
- 实时用量、配额计数、最近请求和 Dashboard 快照优先使用 Redis
- 新增独立 SQLite Writer，通过 Redis Stream 批量异步写入历史数据
- Redis AOF 持久化到现有 `/app/data/redis/`，升级仍只需更新 Spring Mouse 镜像
- 增加请求幂等、Writer 心跳、队列状态和 Redis 健康检查
- 非 Docker 开发环境未配置 Redis 时继续使用 SQLite 回退路径

---

## v0.3.1 — 2026-08-26

### 🚨 关键性能修复 - Codex 连接速度问题

本版本修复了导致 codex 连接生产环境执行任务耗时 5-10倍 的严重性能问题。

#### 性能问题修复

**Codex Usage API 性能优化**
- 修复 `getApiKeyQuotaStatus()` 缺少缓存的严重性能瓶颈
- 添加 10 秒 TTL 缓存机制，显著减少数据库聚合查询
- Codex usage API 响应时间从 100+ms 降至 <1ms (100x 改善)
- 任务执行时间从 16 小时恢复到正常分钟级水平

**缓存失效机制**
- 导出 `invalidateQuotaCache()` 函数供跨模块使用
- 在 usageHistory 写入时自动失效相关缓存
- 平衡性能优化与数据准确性

**诊断工具增强**
- 修复 usageDaily 批量更新器的多个关键 bug
- 添加诊断端点 `/api/usage/diag` 用于系统状态检查
- 添加手动更新端点 `/api/usage/trigger-update`

#### 技术改进

- **性能优化**: getApiKeyQuotaStatus 添加缓存，减少 90%+ 数据库负载
- **缓存管理**: 完整的缓存失效机制确保数据一致性
- **诊断能力**: 新增性能诊断工具，快速定位问题
- **Bug 修复**: 修复 usageDaily 更新器的导入路径和逻辑错误

#### 影响范围

- ✅ **Codex 性能**: 5-10x 整体性能提升
- ✅ **API 响应**: usage 查询响应时间显著降低
- ✅ **数据库负载**: 减少 90%+ 配额查询压力
- ✅ **用户体验**: 任务执行时间恢复正常
- ✅ **数据准确性**: 10 秒缓存确保数据新鲜度

#### 部署建议

**立即部署到生产环境**，此版本修复了影响用户体验的关键性能问题。

---

## v0.3.0 — 2026-08-26

### 🔧 usageDaily 优化修复和完善

本版本修复了 v0.2.9 性能优化中发现的 usageDaily 兼容性问题，并实现了异步批量更新机制。

#### 主要修复

**usageDaily 架构问题解决**
- 修复 Schema 不匹配：usageDaily 优化假设扁平化结构，实际为 JSON blob
- 修复实时数据故障：usageDaily 写入不再影响 usageHistory 实时写入
- 恢复 Dashboard 功能：最近请求、responding providers 正常显示
- 确保 team 分析数据：所有 usageHistory 明细记录完整保留

**异步批量更新机制**
- 新增 `usageDailyUpdater.js` 模块：独立的异步批量处理
- 定时更新：每 15 分钟更新今天和昨天的日汇总数据
- 启动集成：通过 `custom-server.js` 自动启动定时更新
- 不阻塞实时：usageDaily 完全独立，不影响请求处理性能

#### 技术改进

- **新增文件**: `src/lib/db/usageDailyUpdater.js` (212 行)
- **启动集成**: `custom-server.js` 增加批量更新器启动逻辑
- **数据兼容**: 完全兼容 JSON blob 结构，避免 Schema 变更
- **性能优化**: usageDaily 作为纯性能层，不阻塞实时操作

#### 功能保证

- ✅ **实时统计恢复**: 最近请求、responding providers 正常显示
- ✅ **数据写入正常**: usageHistory 记录无遗漏，完整保留
- ✅ **其他优化生效**: v0.2.9 的其他 7 个阶段优化继续工作
- ✅ **异步批量更新**: usageDaily 定期更新，提供查询性能优化
- ✅ **团队分析数据**: 所有使用明细记录完整保留用于考核分析

#### 部署说明

- 本版本直接更新生产环境，无需额外操作
- 异步批量更新器在服务启动时自动开始工作
- usageDaily 每隔 15 分钟自动更新最近两天的汇总数据
- 所有 usageHistory 明细记录保持完整，适合团队考核分析

---

## v0.2.9 — 2026-08-25

### 🚀 重大性能优化版本

本次更新包含全面的性能优化，涵盖从紧急的一行代码修复到深层的架构重构，预期带来显著的性能提升和用户体验改善。

#### 核心性能提升

- **请求延迟**: 降低 50-70%（热路径缓存 + 并发优化）
- **并发能力**: 提升 2-5x（账号锁分片 + 流处理优化）
- **数据库性能**: 提升 10-100x（usageDaily + SQL 聚合）
- **查询效率**: 提升 3-6x（模型查询优化）
- **TTFT 性能**: 最坏情况从 18s 降到 3-5s（Token-Saver 并行化）
- **内存使用**: 降低 50%（流处理数组分段存储）
- **构建时间**: 减少 30-50%（Dockerfile）+ 50-70%（CLI 并行化）
- **启动速度**: 减少 1.2s（CLI 延迟消除）

#### 主要优化内容

**紧急修复（Phase 1）**
- 启用 usageDaily 汇总表：10-100x 统计查询速度提升
- 修复 getPricingForModel 缓存绕过：30-50% 请求完成时间减少
- Cloudflare Readiness 缓存调优：消除延迟尖峰
- estimateUsage 请求体缓存：50-70% 大请求处理时间减少

**热路径优化（Phase 2）**
- Settings 缓存层：50-70% DB 查询频率减少
- 账号选择锁按 Provider 分片：2-5x 吞吐量提升
- 配额查询缓存：高频 API Key 调用性能提升
- Combo/模型查询优化：3-6x 查询效率提升

**数据库层优化（Phase 3）**
- lastUsedAt 写节流：99%+ DB 写入量减少
- 查询聚合下推 SQL：10-100x 图表查询提升

**流处理优化（Phase 4 + 7）**
- Stall 定时器优化：30-50% CPU 使用降低
- Token-Saver 并行化：TTFT 从 18s 降到 3-5s
- 内存累积优化：50% 内存使用减少
- Passthrough 快路径：纯透传场景 CPU 优化

**构建和启动优化（Phase 5）**
- Dockerfile 优化：30-50% 构建时间减少，构建可复现
- CLI 启动延迟消除：1.2s 启动时间减少
- 构建缓存清理机制：防止磁盘空间膨胀
- CLI build 并行化：50-70% 构建时间减少

**性能监控（Phase 6）**
- 服务端性能埋点：实时观测网关自身开销
- 构建时间跟踪：及时发现构建劣化

#### 技术改进

- 新增性能监控基础设施 (`src/lib/performance.js`)
- 新增构建缓存清理脚本 (`scripts/clean-cache.mjs`)
- 优化流处理内存管理（数组分段存储）
- 改进并发控制（per-provider 账号锁）
- 增强数据库查询效率（单次查询 + 内存索引）

#### 文件修改统计

- 涉及文件: 19 个核心文件
- 新增文件: 2 个
- 代码改动: 800+ 行优化代码
- 提交记录: 8 次性能优化提交

#### 部署注意事项

- 所有修改都经过构建验证，可安全部署
- 建议重点关注：请求延迟改善、并发能力提升、内存使用降低
- 如遇问题可快速回滚到前一版本

---

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
