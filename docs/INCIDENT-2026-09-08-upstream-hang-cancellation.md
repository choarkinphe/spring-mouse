# 事故复盘补充：2026-09-08 上游无响应导致请求滞留

- **严重级别**：S2（已确认存在的高并发资源滞留风险；尚无完整生产并发/句柄数据）
- **状态**：代码级缺陷已修复并完成定向回归；生产验证与其他入口审计未完成
- **可用基线**：`sha-6b91063` / `v0.4.35` 是用户反馈的可用版本，但不能据此推断本缺陷首次出现或其是否为前次所有故障的唯一根因
- **影响窗口**：用户于 2026-09-08（Asia/Shanghai）反馈；精确开始、恢复时间未取得生产日志，不能补造
- **关联报告**：[请求不可用与错误归因](./INCIDENT-2026-09-07-network-request-realm.md)

## 摘要

用户报告：当客户端向中转服务并发发送很多请求、渠道（上游）无法响应时，请求会持续卡住；断开客户端与中转的连接并重启服务后恢复。

本次确认该风险**存在**，但需要区分两层结论：

1. 已确认的代码缺陷：聊天请求的客户端断开信号未传到 `chatCore` 内部的上游执行控制器；对 MITM DNS 绕过名单中的主机，`proxyAwareFetch()` 会创建原始 `net.Socket` + `https.request`，旧实现完全忽略传入的 `AbortSignal`。因此，客户端已断开或 60 秒连接超时后，该原始 TCP/TLS 请求仍可能无限等待并累积。
2. 未确认的生产归因：该缺陷可以解释“断开客户端/重启后恢复”的机制，但没有生产的活动 socket 数、请求 ID、目标 host 和连接阶段日志，不能把 2026-09-07 至 2026-09-08 的所有请求不可用都归为这一个根因。

本次修复把客户端断开、上游连接超时和重试等待统一纳入同一取消链路；对于聊天与 `/v1/responses`（该路由复用聊天 handler），无响应的上游请求不应再在客户端离开后继续占用原始 socket 或等待重试退避。

## 用户影响

- 受影响范围（已确认）：经 `handleChat()` → `handleChatCore()` → executor → `proxyAwareFetch()` 的聊天请求；`/v1/responses` 同样复用这条入口。
- 高风险渠道：使用 MITM DNS 绕过名单的 host，例如 Google Cloud Code、GitHub Copilot、AWS CodeWhisperer / Q、Cursor 的部分 host。
- 可见后果：挂起请求持续占用连接、内存、并发槽位或账号可用容量；达到资源阈值后，新请求可能排队、超时或看似“全不通”。服务重启会销毁这些进程内资源，所以会暂时恢复。

## 调用链与失败边界

```text
客户端 Request.signal
  -> src/sse/handlers/chat.js
  -> handleChatCore()
  -> createStreamController().signal
  -> BaseExecutor.execute()
  -> proxyAwareFetch()
  -> createBypassRequest()  [MITM DNS 绕过时的 raw net.Socket + https.request]
  -> 上游
```

修复前，入口虽然已把 `request.signal` 作为 `clientSignal` 传入，但 `handleChatCore()` 不接收、也不传递该字段，因此内部 `AbortController` 不会因客户端断开而取消。即使 executor 已创建 60 秒连接超时信号，raw DNS-bypass 分支也没有监听 `options.signal`，所以 TCP/TLS 握手或首包等待可能不受该超时约束。

普通 `fetch` 分支仍有 `FETCH_CONNECT_TIMEOUT_MS`（默认 60 秒）保护响应头等待；这不是“所有无响应路径都无限等待”的证据。当前未覆盖的是：非流式响应已经返回 headers、但 body 永不结束时的独立 body deadline，以及聊天外入口（如 embeddings、图像、TTS、搜索等）的客户端断开传播。

## 证据分级

### 已验证事实（F）

| 编号 | 事实 | 证据 | 结论边界 |
|---|---|---|---|
| F-01 | 聊天入口向 `handleChatCore()` 传入 `clientSignal: request.signal`，但修复前 `handleChatCore()` 未接收并转发该字段。 | `src/sse/handlers/chat.js`、修复前 `open-sse/handlers/chatCore.js` 签名与调用。 | 客户端断开未进入上游 controller。 |
| F-02 | executor 将内部 signal 传给 `proxyAwareFetch()`，并设置 `FETCH_CONNECT_TIMEOUT_MS`（默认 60 秒）的响应头等待超时。 | `open-sse/executors/base.js`、`open-sse/config/runtimeConfig.js`。 | 只说明正常 fetch 的连接/响应头等待有上限。 |
| F-03 | MITM DNS 绕过分支使用原始 `net.Socket` 与 `https.request`，旧实现未读取或监听 `options.signal`。 | 修复前 `open-sse/utils/proxyFetch.js` 的 `createBypassRequest()`。 | 对该分支，客户端取消和 executor 连接超时不能释放 raw socket。 |
| F-04 | 旧重试退避使用不可取消的 `setTimeout`。 | 修复前 `open-sse/executors/base.js`。 | 连接失败后的 retry delay 也可能在客户端离开后继续占用请求生命周期。 |
| F-05 | 定向测试创建一个接受 TCP 但永不完成 TLS 的本地上游；20ms 后取消，修复后 promise 立即以 `AbortError` 结束且 server 能关闭。 | `tests/unit/proxy-fetch-abort.test.js`。 | 验证 raw TLS 握手的取消，不等价于所有生产网络条件。 |
| F-06 | 定向测试验证客户端 signal 会立即取消上游 controller，并在正常完成后移除监听器。 | `tests/unit/client-disconnect-abort.test.js`。 | 验证聊天控制器的信号桥接。 |
| F-07 | 定向测试验证重试退避期间断开客户端会立即停止，且不会发起下一次 fetch。 | `tests/unit/base-executor-retry.test.js`。 | 验证 BaseExecutor 的 retry wait 不再滞留。 |

### 运行观察（O）

| 编号 | 观察 | 来源 | 结论边界 |
|---|---|---|---|
| O-01 | 多请求并发、渠道不响应后服务表现为卡住；断开客户端并重启服务后恢复。 | 用户反馈，2026-09-08。 | 与 F-01～F-04 一致，但缺少生产连接/请求数据，不能推导出准确阈值。 |

### 未验证假设（H）

| 编号 | 假设 | 验证方式 |
|---|---|---|
| H-01 | 生产中的卡死达到文件描述符、socket、内存或应用并发限制。 | 采集进程 active handles/socket 数、连接状态、heap、请求 pending gauge，并与请求 ID 关联。 |
| H-02 | 聊天外入口也有相同的客户端断开未传播问题。 | 按入口审计 signal：embeddings、图像、TTS、搜索、web fetch、自动 Ping。每个入口增加 fake upstream 取消测试。 |
| H-03 | 非流式 upstream 已发 headers 但 body 永不结束时仍可长期占用请求。 | 建立“headers 后不发 body”的 fake upstream，定义并验证独立 body timeout 与 504/fallback 行为。 |

## 根因与修复

### 确认根因（RC）

- 原始 DNS-bypass 网络实现自行拥有 socket，却没有遵守调用方提供的 `AbortSignal`。
- 聊天请求的客户端断开信号没有接入该上游执行 signal。
- 重试等待也没有监听取消信号。

三者叠加后，只要上游在 raw DNS-bypass 路径上不响应，客户端即使已经断开，挂起连接仍可能留在进程内；重启服务会销毁这些资源，形成“重启后恢复”的表象。

### 已实施修复

1. `open-sse/handlers/chatCore.js`：接收 `clientSignal` 并传给 `createStreamController()`。
2. `open-sse/utils/streamHandler.js`：客户端 abort 立即 abort 内部上游 signal；正常完成/错误时移除监听器。
3. `open-sse/utils/proxyFetch.js`：raw socket 分支监听 signal；abort 时销毁 response、HTTPS request 与 socket，拒绝为 `AbortError`，并清理监听器；同时尊重 URL 指定的端口。
4. `open-sse/executors/base.js`：retry backoff 改为可取消等待，客户端断开后不会再继续等待或发起下一次重试。

## 验证记录

2026-09-08 在本地执行：

```bash
cd /Users/xiaohua/CODE/spring_mouse/tests
./node_modules/.bin/vitest run --config vitest.config.js \
  unit/client-disconnect-abort.test.js \
  unit/proxy-fetch-abort.test.js \
  unit/base-executor-retry.test.js \
  unit/responses-abort-terminal.test.js
```

结果：**4 个测试文件、14 个测试全部通过**。

## 后续行动与关闭条件

| 优先级 | 行动 | 验收证据 | 状态 |
|---|---|---|---|
| P0 | 在预发布做高并发 no-response 演练：N 个聊天请求 → fake upstream 不返回 TLS/headers → 客户端取消。 | 取消后 pending requests、active sockets 回到基线；新请求可立即完成。 | 未完成 |
| P0 | 为每个请求记录脱敏的取消原因、网络阶段、upstream host hash、pending duration、active request gauge。 | 可区分 client abort、connect timeout、first-byte timeout、stream stall、response-body timeout。 | 未完成 |
| P1 | 审计聊天外入口的 client signal 与 timeout 链路。 | 每个入口的 fake upstream 取消测试通过。 | 未完成 |
| P1 | 为非流式 response body 添加明确 deadline 与回归测试。 | headers 后无 body 时按定义返回可诊断错误，且资源释放。 | 未完成 |
| P1 | 将 no-response / client-disconnect 回归纳入 R2/R3 发布门禁。 | CI 必跑，失败阻断发布。 | 未完成 |

本补充报告只能在上述 P0 演练完成、生产指标可确认资源未滞留、并且聊天外入口审计结束后关闭。
