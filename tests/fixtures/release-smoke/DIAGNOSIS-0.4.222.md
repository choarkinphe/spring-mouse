# 0.4.222 发布烟测持久化失败诊断

日期：2026-10-12。范围：修复诊断日志，重跑固定镜像，定位原因；不部署、不修改生产参数、不降低门禁阈值。

## 固定实验对象

- 镜像：`choarkinphe/spring-mouse@sha256:09f456bf6c8cfb423cdb8a6640f746233e16c99c6885c869ea978921ca3d6c75`
- 架构：linux/amd64
- Git revision：`6ca3a35b2ec0a283be92108aab492cef1c7b7f09`
- 版本：0.4.222
- Node：v22.23.3；Next：16.3.1；undici：7.29.0
- lockfile SHA-256：`b6acdc48b2be3d060962eedfd1c773142dc428201acdb5fe21c472a29f6881bd`

本机无 Docker，借用既有主机的 Docker 在独立内部网络、独立数据卷和临时容器中运行。未挂载生产数据库或凭据。测试 runner 只为调用宿主 Docker 使用其 socket；测试应用仍为上述原始镜像。生产 spring-mouse 容器启动时间前后一致，健康状态保持 healthy。此为独立重跑，不是重跑 GitHub Actions。

## 日志修复

`read-db.mjs` 原先把计数写 stdout 后 `process.exit(1)`；`release-container-smoke.mjs` 的 Docker 包装器在非零退出码时只输出 stderr，所以计数不可见。

现在失败时通过 stderr 输出 `check`、聚合 `counts`、未达标指标及阈值；成功 stdout 格式不变。Docker 错误增加 exit code 与 signal。不转存通用 stdout，避免把其他命令可能包含的凭据写入日志。12/12/2 三项原始阈值保持不变。

## 实验结果

| 实验 | 用量行数 | 路由尝试 | 成功终态 | 不同账号数 | 结果 |
|---|---:|---:|---:|---:|---|
| 默认 200ms，补全错误日志 | 27 | 8 | 2 | 2 | 失败：成功终态小于 12 |
| 默认 200ms，停机前额外等待 15 秒 | 27 | 7 | 2 | 2 | 失败，等待前后计数完全一致 |
| 默认 200ms，追加生产者健康统计 | 27 | 8 | 2 | 2 | 失败：104 个事件仅 20 个发送成功 |
| 仅测试环境改为 2000ms，其他镜像/阈值不变 | 27 | 26 | 16 | 2 | 完整烟测通过 |

每轮 HTTP 请求矩阵与取消测试均通过。失败对照的 Redis 路由 stream 长度 0、消费者 pending 0、lag 0；停机前后及等待 15 秒前后计数均无变化。不是尚未消费的积压，也不是本轮关停丢失了这些行。

生产者健康对照：

| 指标 | 默认 200ms | 仅实验改为 2000ms |
|---|---:|---:|
| enqueued | 104 | 104 |
| sent | 20 | 104 |
| failed | 84 | 0 |
| droppedQueueFull | 0 | 0 |
| droppedInvalid | 0 | 0 |
| Redis timeouts | 2 | 0 |
| Redis errors | 3 | 0 |

## 确认的失败机制

1. `src/lib/redis/routingClient.js` 默认操作预算 200ms，预算包含连接建立和命令执行。
2. 超时或错误调用 `discard()` 销毁客户端并进入 1000ms 退避；退避期 `readyClient()` 直接返回 null。
3. `src/lib/redis/routingEvents.js` 的 `deliver()` 对 null 只累计 failed，不保留或重试事件。
4. 本次默认配置确实发生超时，84/104 个路由事件在应用交付侧失败，因而 SQLite 成功终态不足；独立的用量路径仍有 27 条记录。
5. 同镜像只改变实验超时预算后 104/104 事件交付、16 条成功终态，证明该超时/退避丢弃机制可以解释并消除本次复现失败。

边界：这些证据确认丢弃机制，不区分 200ms 具体耗在首次连接、某条 Redis 命令还是事件循环延迟。未证明所有生产环境都会复现，未验证 arm64 对照，未做真实上游测试。

## 验证与处理状态

- 日志/WAL测试 7 项通过，含真实子进程退出码与 stderr 聚合计数回归。
- 与 routing Redis client / routing events / routing writer 合计 45 项测试通过。
- 修改文件 ESLint、`git diff --check` 通过。
- 诊断对照的 2000ms 没有写入生产配置、正式 smoke 默认值或业务代码。
- 当前默认 200ms 的候选仍不能宣称通过发布门禁。生产逻辑的后续修复需要单独验证连接准备、失败退避和有界交付策略，不能直接以放宽阈值或实验参数替代修复。
- 未提交、未推送、未部署。临时测试容器、网络和数据卷由脚本自动清理。
