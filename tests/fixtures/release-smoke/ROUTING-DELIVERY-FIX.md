# 路由事件交付修复验证（2026-10-12）

## 修复边界

`src/lib/redis/routingEvents.js` 增加有界重试，不修改 `routingClient.js` 的默认 200ms 超时及 1s 连接退避：

- 事件生成时固定 UUID、脱敏 payload 和期限，重试复用。
- Redis Lua 原子 GET / XADD / SET，去重键保留 60s，超过事件 10s 重试期限。回复丢失后的重试不会重复写流；消费并删除原流项后也不会重新插入。
- 1s 重试退避、最多 5 次尝试、10s TTL；默认 1000 个排队事件、8 个在途事件，总 payload 不超过 4MiB。
- 连接暂时不可用时暂停新事件出队，不把整个队列快速消耗成失败；队列满、超字节、过期或重试耗尽仍可降级丢弃并公开计数。
- 调度状态在 globalThis 单例中，多个模块实例共享退避/计时器。
- 业务请求不等待遥测；长期断网/进程被杀不保证零丢失，未升级为持久化 outbox。

## 自动检查

- 12 个相关测试文件，171 项通过。
- 覆盖超时后复用去重键、退避期间 100 个新事件、重试耗尽、TTL、字节限额、重试遇队列满、跨模块实例共用计时器、WAL 与日志输出。
- Redis 实例验证：同一 event token 并发 20 次仅有一个流项；消费后再重试不会重新插入，TTL 大于重试窗口。
- 新增 release smoke 检查 producer 的 sent == enqueued、最终 failed == 0、各项丢弃 == 0，避免只看 HTTP 200 掩盖遥测丢失。

## 本地构建与容器验证

- 从已提交 main 加工作区补丁形成源码快照，不包含生产环境文件或真实凭据。
- 使用项目 Dockerfile 的 Node 22、锁文件 npm ci 和生产 Next webpack 构建。主机没有 BuildKit，本地副本仅移除了 `RUN --mount=type=cache`（原 Dockerfile 未修改），使用官方 npm registry。
- 不可变本地镜像 ID：`sha256:ea6c97208d244e31c1287d2aa0213299dd197a047ad66b04c96b6aedb1db5971`。
- revision 标签：`6ca3a35-routing-fix-local`，明确不是已发布 Git commit。
- Node v22.23.3 / Next 16.3.1 / undici 7.29.0，lockfile SHA-256 `b6acdc48b2be3d060962eedfd1c773142dc428201acdb5fe21c472a29f6881bd`。
- 本地 smoke 入口仅把 `repo@sha256:digest` 输入校验替换为本地 `sha256:imageId` 校验；正式发布脚本仍只接受 registry digest。其余默认配置和持久化门槛不变，无 2000ms 覆盖。

首轮完整通过（exit 0）：

| 指标 | 修复后 |
|---|---:|
| Redis timeoutMs | 200 |
| Redis timeouts | 2 |
| enqueued / sent | 104 / 104 |
| failed | 0 |
| retried | 1 |
| pendingBytes / queued / inFlight | 0 / 0 / 0 |
| 所有 dropped 指标 | 0 |
| usageRows | 27 |
| attempts | 26 |
| completedAttempts | 16 |
| selectedAccounts | 2 |

12 组 HTTP/TLS 流式与非流式矩阵、四阶段取消、直连/代理取消、20 并发取消与健康恢复、真实 Redis 原子去重、停机后的 SQLite 验收均通过。

第二次冷启动在 `/api/auth/login` 返回 500，发生在路由测试之前，因此不是路由交付断言失败；不能把重复运行全部称为成功。保持原始失败，不增加登录重试来掩盖。第三次使用同一镜像和默认配置再次完整通过，关键指标与首轮完全相同：104/104 事件、0 failed、1 retried、26 attempts、16 valid_terminal。登录 500 的根因尚未确认，不将它归为已证实的无关问题。

## 发布限制

本次是 linux/amd64 本地候选验证，不是 GitHub Actions 双架构检查，不是正式镜像发布，未做真实上游请求。未提交、未推送、未部署；线上容器启动时间和健康状态保持不变。
