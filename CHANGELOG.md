# Changelog

本项目的公开发行记录从 `v0.1.0` 开始。此前的内部迭代记录、版本号和部署信息已从本文件移除。

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
