# 2026-09-08 内存与请求热路径优化记录

- **状态**：第三轮代码优化、隔离回归和本机故障模拟完成；尚未完成容器/真实渠道与生产流量验证
- **范围**：入口网络流量计量、请求详情观测写入、常驻 Map/定时器与 usage dashboard 聚合审计
- **原则**：业务请求优先；观测逻辑不得复制大请求、无限排队或改变业务 Request；结论区分实测、代码事实和待验证风险

## 结论摘要

本轮确认并修复了三个内存/延迟问题：

1. 对没有 `Content-Length` 的请求，流量统计会执行 `request.clone().arrayBuffer()`，为长请求创建第二个完整 body 消费者。基准中，64 MiB 流式请求完成后仍额外保留约 64 MiB external memory，并使总处理时间从约 332 ms 增加到约 358 ms。
2. 请求详情压缩先对每个字段执行完整 `JSON.stringify()`，再只保存 200 字符预览。对复用同一个 32 MiB 字符串的四个字段，旧实现耗时约 55–59 ms，GC 后 heap 约 163 MiB；短预览字符串还可能保留大 JSON 字符串的 backing store。
3. 请求详情数据库延迟写队列按单条大小做了压缩，但记录数量没有上限。如果数据库长时间变慢、初始化挂起或持续不可用，新记录仍可持续进入队列。

修复后，同一请求详情基准耗时约 3.1–3.5 ms，GC 后 heap 约 35 MiB（主要是基准本身持有的 32 MiB 输入）；64 MiB 流式请求完成后的 external memory 回落至约 2.2 MiB。以上是本机微基准结果，不等同于生产 RSS 降幅。

## 证据分级

### 已实测（M）

| 编号 | 场景 | 修复前 | 修复后 | 边界 |
|---|---|---:|---:|---|
| M-01 | 64 MiB、无 `Content-Length` 的流式 Request，同时消费业务 body 与统计 clone | 总耗时 356–360 ms；GC 后 external 增量约 65.9 MiB | 总耗时 325–335 ms；GC 后 external 增量约 2.2 MiB | Node 本机微基准；不含真实上游和数据库 |
| M-02 | 同一 32 MiB 长字符串进入 4 个 request-detail 字段，限制 5 KiB | 55–59 ms；GC 后 heap 约 163.4 MiB | 3.1–3.5 ms；GC 后 heap 约 35.4 MiB | 输入对象仍由基准持有，因此 35 MiB 不是泄漏 |
| M-03 | 聚焦回归 | — | 4 个测试文件、23 个测试通过 | 覆盖网络计量、traffic repo、详情内存边界和 DB 并发 |

### 已验证代码事实（F）

| 编号 | 事实 | 处理 |
|---|---|---|
| F-01 | `withNetworkTraffic()` 对未知长度请求执行完整 clone + `arrayBuffer()`。 | 不再为计量创建第二个完整 body 消费者；仅使用声明的 `Content-Length`，未知长度记为 0。 |
| F-02 | 第一轮移除 header 注入、仅用 WeakMap，会丢失跨适配器和 Chat 核心的关联。 | 第二轮撤回这一改动，保留可用基线的同 realm 构造器 + header 注入及 fail-open fallback；服务端 WeakMap ID 优先于外部 header。详见下文。 |
| F-03 | `compactJsonField()` 在判断是否超限前完整序列化。 | 增加有上限的预算扫描；明显超限时只构造有界结构预览，不再完整序列化。 |
| F-04 | 200 字符 `slice()` 可能继续引用大字符串 backing store。 | 强制复制为独立小字符串。 |
| F-05 | request-detail `writeBuffer` 没有记录数上限。 | 队列上限取 `max(maxRecords, batchSize)`；溢出时丢弃最旧观测记录并限频告警。 |
| F-06 | request-detail 延迟 flush timer 没有 `unref()`。 | 增加 `unref()`，避免纯观测 timer 阻止进程自然退出。 |

## 行为变化与取舍

- 有合法 `Content-Length` 的请求仍准确统计 request bytes。
- 未声明长度的 chunked/streaming 请求不再为统计而读取第二遍 body，request bytes 记录为 0；response bytes 仍按实际下游消费精确计量。
- 这是有意的准确性取舍：宁可少记未知 request bytes，也不能让非关键流量统计复制长 prompt、增加 GC 压力或影响上游请求。
- request-detail 队列满时只丢弃最旧的观测记录，不阻塞、不取消、也不修改业务请求。数据库最终只保留 `maxRecords` 条，继续排队超过该数量没有业务价值。
- 对通过预算扫描提前判定超限的详情，`_originalSize` 是“至少超出限制”的下界，并以 `_originalSizeExact: false` 标识；不会再为了观测精确值完整序列化大对象。

## 第一轮已有边界及第二轮纠正

- usage dashboard 聚合已有进程内 single-flight、短 TTL、stale-while-refresh 和最多 50 个 cache entry；SSE full refresh 最快 5 秒一次。
- recent usage ring 上限为 50。
- 第一轮仅看见 proxy dispatcher Map 的 20 条限制是不充分的：并发初始化可绕过限制，删除 Map 引用也不会关闭连接池；第二轮已修复。project-id cache 有 TTL sweep；Kiro session replay 有 5000 条上限和 TTL 清理，仍不能推断总字节有界。
- response traffic 使用下游 pull 驱动的流式计量，未发现整包 response buffering。

这些事实只说明已有边界，不代表在生产数据规模下没有 CPU 或 RSS 问题。

## 剩余风险与下一轮建议

1. **生产负载验证**：记录 idle RSS、100/500 并发长请求峰值、取消后 1/5/15 分钟 RSS、external、heap、active handles、event-loop delay 和 p50/p95 TTFT。
2. **Kiro session replay**：虽然条数有上限，但单条可包含较大的首轮消息和 system prompt；应进一步增加总字节预算，而不是只按 5000 条限制。
3. **模型/凭据缓存**：Kiro、Qoder、Vertex 的部分 TTL Map 采用访问时过期（refresh-result 已在第二轮修复），过期但不再访问的键可能继续驻留；需统一最大条数和 sweep，并确保不长期保留原始 token/PAT。
4. **pending flow 高基数**：每个唯一 `(connection, model, apiKey)` flow 有独立 60 秒 timer；需要用高基数合法 key 压测，再决定是否改为共享时间轮/sweep。
5. **dashboard 聚合**：已有缓存，但首次冷查询仍扫描 usage history 并构造多个维度；需要基于真实行数做 SQL profile，不能仅凭代码继续重写。

## 发布门禁补充

后续修改入口观测、Request/Response 包装或延迟写队列时，至少必须验证：

- handler 收到的 Request 必须可读，客户端 abort signal 不丢失；metadata 包装须使用同 realm 构造器，并验证所有会重建 Request / 序列化 headers 的消费端；
- 未知长度的大请求不会被 clone 或整包读取；
- 观测数据库挂起时，内存队列有明确上限且业务请求不等待；
- 大详情压缩的时间和 retained heap 与输入大小不呈多份线性增长；
- declared request bytes、streamed response bytes、request id 关联仍通过单元测试。

## 测试限制

第一轮扩大运行整个 `tests/unit` 时，遇到尚未全部基线归因的失败，包括缺失 `cliTools.js`、`lowdb`、cloud-only 模块、无测试套件文件，以及沙箱禁止监听 `127.0.0.1`。因此不把全量命令作为通过证据，也不将所有失败笼统归为无关。第二轮使用隔离 DATA_DIR 完成下述定向测试；生产发布仍需满足容器和真实上游门禁。


## 第二轮深挖（2026-09-08）

### 1. 纠正第一轮流量 ID 关联回归

第一轮宣称所有消费方都可使用 WeakMap，这个判断不完整。`chatCore` 实际读取 `clientRawRequest.headers` 中的 ID；Responses compact/Gemini 等适配器还会重建 Request。仅验证 `getTrafficRequestId(request)` 的单元测试不足以证明下游可关联。

当前恢复原基线的同 realm metadata 包装和 header 传播，同时保留“不执行 `request.clone().arrayBuffer()`”的内存优化。Request 构造与 `Request.clone()` 不是同一行为，不能把前者直接描述为第二次 body tee。增加了 header 序列化、适配 Request 重建、外部伪造 ID 优先级、跨 realm abort 和未结束上传提前返回的回归测试。特殊构造器 fallback 后又重新构建 Request 的完整适配链仍需容器级验证。

### 2. 代理连接池并发分配与淘汰

原实现先判断 Map 缺失和容量，再 `await import("undici")`，最后创建连接池。多个并发首次调用会全部通过前置判断，各自创建实例；同 key 互相覆盖，不同 key 可超过 20 条。淘汰时也没有 `close()`。

修复为共享 lazy-import promise，等待 import 后再原子地检查/创建/限制容量。淘汰实例在下一事件循环调用 graceful `close()`，避免刚取得旧实例的调用尚未 dispatch 就被关闭；关闭等待不阻塞新请求，不用 `destroy()` 强制中断现有响应。使用已安装 Undici 的 `docs/docs/api/Dispatcher.md` 核对 close 的排空语义。

可复现结构基准：

```bash
node scripts/benchmark-proxy-pools.mjs c7a1e22
```

| 场景 | 基线 | 当前代码 |
|---|---:|---:|
| 同代理 100 个并发首次请求：创建连接池数 | 100 | 1 |
| 40 个不同代理并发：创建数 / 发起关闭数 | 40 / 0 | 40 / 20 |
| dispatch 时池已关闭 | 0 | 0 |

**证据边界**：基准执行源码的缓存逻辑，注入无网络的模拟 ProxyAgent/fetch；创建数不是实际 socket 数或 RSS。Map 最多 20 个可复用实例，不代表“活动池 + 排空池”总数严格不超过 20；如果旧请求永不结束，graceful close 仍需等其完成。不得为追求内存数字强行终止正常业务请求。

### 3. 刷新结果缓存的驻留与失败污染

旧 token 在轮换后通常不会再次访问，因此“下次访问时检查 10 秒 TTL”不能释放旧 key / 新凭据结果。另外 `fn()` 同步抛错时，旧代码先运行删除逻辑、再把 rejected promise 写入 Map，使后续刷新持续复用失败。

现在区分 in-flight 与已完成结果：

- 已完成结果最多 1000 条，复用 TTL 仍为 10 秒；
- 单个 `unref()` 清理 timer，驻留过期后最多再等一个 10 秒清理周期；缓存清空后停止 timer；
- key 使用旧 token/provider 的哈希，不直接保留旧 token 字符串；
- 先登记 pending，再调用刷新函数，同步/异步失败均清理；
- 不驱逐仍运行的刷新任务，保留 single-flight，避免 token 刷新风暴。

**未解决边界**：in-flight 函数如永不 settle 仍可驻留，底层刷新需要统一 AbortSignal/deadline。不能用简单删锁来假装释放网络资源。

### 4. Dashboard SSE 慢客户端积压

原 route 的 update/pending/keepalive 直接 `controller.enqueue()`，从不检查 `desiredSize`。聚合已有 5 秒限频并不等于客户端发送队列有界，尤其 pending patch 可不断产生。

当前仅对 **usage dashboard SSE** 合并过期状态：流队列最多一个已编码 chunk，额外仅保留最新一个待发全量快照和一个待发实时 patch；队列满时不编码/排入心跳。恢复读取先发最新全量再发 patch，不逐条补发历史状态。abort/cancel 清理 listener、timer 和待发引用，abort 也结束 pending read。

测试复现：100 次 pending 更新期间不读取，旧实现下一条返回第 1 次更新，修复后直接返回第 100 次；另覆盖连续 full refresh、心跳积压、已中止 signal、阻塞 read 的 abort 结束。本改动不作用于聊天 token/SSE 输出，不丢弃模型内容。

### 第二轮验证

- 隔离临时 DATA_DIR：14 个定向测试文件，**77 / 77 通过**；涵盖新生命周期测试、流量/详情、DB 并发、usage scope、ingress/embedding 关联、executor retry、non-stream body deadline 和 Headroom chat core。
- 原始 TCP/TLS 取消回归：沙箱首次因监听限制失败，经授权仅监听本机临时端口重跑，**2 / 2 通过**。
- 合计 **15 个测试文件、79 个测试通过**；结构基准结果如上。未跑生产部署、真实渠道负载或完整容器构建；没有提交、推送或升级版本。
- 旧 usage-stream 测试漏 mock `resolveUsageDashboardScope`，曾触及默认用户数据库路径；这次补齐 mock，并对扩大测试统一设置临时 DATA_DIR，不以解除沙箱限制来访问用户数据库。

### 仍未关闭的风险

除前述 Kiro/模型缓存字节预算、in-flight 凭据 deadline、排空代理池外，`networkTraffic` 的 finalize 仍等待 `saveNetworkTraffic`，慢 DB 可能拖慢响应 EOF/错误返回；需要下一轮设计有界、可观测的持久化隔离，不能简单改成无限 fire-and-forget。第一轮 request-detail 队列数量上限并不覆盖所有等待配置/DB 的调用和所有记录字段总字节。生产高内存/慢响应问题继续保持未关闭状态。


## 第三轮：落实剩余三个问题（2026-09-08）

上节“仍未关闭的风险”描述第二轮结束时的状态；本节记录随后实施的修复，不能混为已经过生产验收。

### A. 流量落库不再阻塞响应结束，但必须有界

确认：原 `withNetworkTraffic.finalize()` 会等待 `saveNetworkTraffic()`。即使响应内容已产生，只要保存 promise 不完成，EOF、空响应和异常返回都可能被观测逻辑拖住。新增挂起保存测试在修复前失败，修复后可完成响应。

当前使用专用于 network-traffic 观测的队列：

- 单个 drain worker，只允许 **1 个在途保存**；不对未结束的 DB 操作做 timeout 后再开一个任务。
- 待写队列最多 **256 条且序列化存储预算不超过 1 MiB**，另加单条在途记录。超限丢弃最旧观测记录。
- 只接受固定字段，并限制 endpoint/source metadata 长度，保存独立 JSON 字符串；不引用原 Request、响应体或任意对象。
- 在下一事件循环开始写入，每 20 条让出一次执行机会。失败/丢弃计数可查询，诊断日志限频 60 秒且不输出正文/凭据。
- 故障注入：阻塞第一个保存，再入队 1000 条，测试限制为 3 条时，始终只有 1 在途 + 3 待写；释放阻塞后保存最新 3 条并恢复。另有独立字节上限、metadata 脱离原对象和失败后继续处理测试。

**取舍与边界**：流量视图改为最终一致；过载、失败或进程退出可能缺少部分流量观测记录。这不是 token 用量/配额写入队列，不能用于需要无损保存的计费数据。后台仍运行于同一个 JS 线程；同步 SQLite 调用或 CPU 工作本身阻塞事件循环，不能靠 setImmediate 抢占。本次解除的是响应对异步落库 promise 的直接等待，并限制滞留数量，不宣称已隔离所有同步数据库停顿。

文件：`src/lib/networkTrafficWriter.js`、`src/lib/networkTraffic.js`。

### B. Kiro 冻结首轮缓存增加实际存储预算

以前 5000 条只约束数量，不约束消息大小。当前：

- 序列化存储预算 **32 MiB 总量 / 2 MiB 单条**，同时保留原 5000 条上限。
- 缓存保存独立序列化值；命中后解析为可修改副本，不让调用方修改冻结消息。
- 按访问顺序淘汰；覆盖、TTL 清理、访问时过期和 clear 都扣回预算。
- 超大首轮只跳过缓存，不截断或删除实际发送内容。缓存命中率/前缀复用可能下降，与原 TTL/容量淘汰一样属于缓存行为变化。
- 预算按 UTF-16 字符存储、key 和固定开销估算，不等于 V8 的精确 RSS 上限；超大输入的初次序列化仍可能有瞬时分配，业务输入大小控制需另行审计。

可复现基准（独立子进程，合成数据，无真实用户正文）：

```bash
node --expose-gc scripts/benchmark-kiro-cache.mjs
```

400 个会话，每个约 128 KiB 首轮文本，对比基线 `c7a1e22`：

| 指标 | 基线 | 工作区修复后 |
|---|---:|---:|
| GC 后 heap 增量 | 50.26 MiB | 16.07 MiB |
| clear 后 heap 增量 | 0.15 MiB | 0.16 MiB |
| 当前缓存数量 / 计量字节 | 原实现无字节计量 | 127 / 33,337,754（小于 32 MiB） |

这是本机合成缓存基准，不是生产总内存降幅。既有 Kiro conversation canonicalization 测试与新缓存边界测试一并通过。

文件：`open-sse/utils/kiroSessionReplay.js`、`open-sse/config/runtimeConfig.js`。

### C. 共享凭据刷新增加传输 deadline，保留已轮换 token

共享 `dedupRefresh` 为每个真实刷新任务创建一个内部 AbortController，默认 **60 秒**，可通过 `TOKEN_REFRESH_TIMEOUT_MS` 设置正整数毫秒。回调接收该 signal；它已传到通用 OAuth、Google、Codex、Kiro 各认证分支、Copilot、Codebuddy、Trae、xAI discovery/refresh 和 Vertex mint 的网络请求。

- deadline 覆盖等待 headers 和读取 json/text body，不在收到 headers 时提前清除。
- 到期 abort 底层传输并结束共享任务，移除 in-flight 项；上层 credential lock 随结果 settle 释放。
- 超时按现有刷新失败语义返回 null，不写入 recent result cache；忽略 signal 的依赖即使迟到返回，也不能污染新缓存。
- xAI discovery 被取消后不再转去静态地址继续刷新。
- **Kiro token 结果先进入共享缓存，再执行可选 profile 发现**；profile 发现单独 single-flight 和 **5 秒** deadline，失败时仍返回已经成功轮换的新 token。不能把 token 更新与非关键元信息查询当作同一失败单元。
- 共享刷新不绑定任意一个聊天客户端的取消信号，防止一个客户端断开取消其他调用方正在等待的同一刷新。

验证：

- 模拟 headers、body 不结束时，传入的 signal 被 abort；下一次刷新成功。
- 两个调用方共享同一上层 credential lock，超时后均返回，下一次调用能够重新刷新。
- xAI discovery stall 不再发起 fallback；Vertex 测试通过实际生成的临时 RSA key/JWT signer，网络阶段使用假 fetch；没有真实凭据。
- Kiro profile stall 被取消，但返回的新 access/refresh token 保留。
- 非协作依赖迟到结果不写缓存；这只能防止调用链/缓存继续等待，不能声称任意忽略 signal 的第三方操作已被强制终止。

**真实本机传输故障模拟**：分别让 12 个并发 HTTP 刷新请求停在 headers 前与 JSON body 中。使用测试专用 500ms deadline；到期后假上游的活动请求从 12 回到 0，同一假上游、同一缓存 key 的后续健康请求成功。原 raw TCP/TLS 握手取消回归也通过。首次运行被沙箱监听限制阻止，经明确授权仅开放本机临时端口重跑；未访问真实 OAuth 渠道。

### 第三轮验收记录与边界

- **23 个隔离测试文件，137 / 137 通过**；测试统一设置临时 DATA_DIR。
- **2 个本机传输测试文件，4 / 4 通过**（两种 OAuth 停顿 + 既有 raw TLS/预中止回归）。
- 合计 **25 个文件、141 个测试通过**；`git diff --check` 通过。
- 未提交、未推送，package/lockfile 仍为 `0.4.42`；未进行容器生产构建、真实上游灰度或生产 RSS 观察。
- 本轮覆盖共享刷新路径，不等于所有 OAuth 登录/手动账号测试入口已受 deadline 约束。Qoder/Kiro/Vertex 长期目录/凭据缓存、同步 DB 停顿、image/TTS/STT 的端到端取消，以及生产负载指标，仍需独立验收。
