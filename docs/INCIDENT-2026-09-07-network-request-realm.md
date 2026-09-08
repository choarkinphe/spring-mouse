# 事故复盘：2026-09-07 至 2026-09-08 请求不可用与错误归因

- **事故窗口**：2026 年 9 月 7 日至 2026 年 9 月 8 日（Asia/Shanghai）
- **严重级别**：S1（多个请求入口或账号路径不可用）
- **报告版本**：2.0（2026 年 9 月 8 日重建）
- **状态**：技术复盘完成；本次 `UND_ERR_CONNECT_TIMEOUT` 的直接根因仍待生产取证
- **适用范围**：`/v1` 兼容 API、Provider 账号测试、配额自动 Ping、请求流量监控、账号标签路由和镜像发布

> 本报告替代先前“网络流量监控导致 API 请求全局异常”的单因果表述。先前报告正确记录了一个可复现的跨 realm `Request` 缺陷，但将它与后续所有连接超时混为同一根因，证据不足。本版按“观察事实 / 已验证事实 / 未验证假设”分级，避免再次以相似错误文本替代调用链取证。

---

## 1. 摘要

2026 年 9 月 7 日，系统存在一个已复现的入口级兼容性缺陷：网络流量监控在业务 handler 之前使用全局 `Request` 构造器克隆来自另一 undici realm 的请求时，可能触发私有字段 brand check，导致 handler 不执行。提交 `6b91063` 修复了这个特定问题；用户反馈该版本（`v0.4.35`）可用。

其后，`aff0298` 对同一横切流量监控层再次做了较大范围“加固”，`9f20e53` 又改变了带标签 API Key 的账号候选池。2026 年 9 月 8 日再次出现大面积“请求不通”以及账号卡片中的 `502: fetch failed (cause: UND_ERR_CONNECT_TIMEOUT)`。

本次复盘确认：

1. 跨 realm `Request` 缺陷真实存在，且可能造成入口级故障；
2. 截图所示的“自动 Ping”与账号测试/上游连接路径**不经过** `withNetworkTraffic()`，因此 `UND_ERR_CONNECT_TIMEOUT` 不能仅凭错误文本归因到流量监控；
3. 从 `6b91063` 到当前版本，自动 Ping 与账号测试源码未变化；但流量监控、账号标签路由以及未锁定的运行时依赖均发生了可影响生产行为的变化；
4. 没有完整生产日志、镜像依赖清单、请求关联记录或灰度数据，因此本次连接超时的**直接根因尚未确认**。

本次重复事故的核心不是单一代码错误，而是：**把局部可复现缺陷当成所有相似现象的确定根因；在已知可用基线之上继续叠加横切改动；发布门禁没有验证真实运行时；镜像依赖不可复现；且没有灰度与自动回滚。**

> **2026-09-08 补充**：后续代码审计确认了另一个独立的请求滞留缺陷：聊天请求的客户端断开未传入上游 controller，且 MITM DNS 绕过的 raw socket 不响应 `AbortSignal`。该缺陷可解释“上游不响应、断开客户端并重启后恢复”的机制；它不反向证明本报告中的所有连接超时均由此造成。详见 [上游无响应导致请求滞留](./INCIDENT-2026-09-08-upstream-hang-cancellation.md)。

---

## 2. 影响与用户可见现象

已观察到或被反馈的现象：

- 多类 `/v1` 请求不可用或返回 5xx；
- Provider 账号卡片显示 `502: fetch failed`，原因中包含 `UND_ERR_CONNECT_TIMEOUT`；
- 带“自动 Ping”功能的 OAuth 账号显示错误；
- 回退到 `sha-6b91063` / `v0.4.35` 后，用户反馈恢复正常。

下列内容**没有证据**，不得写入根因结论：

- 所有请求均在流量监控层失败；
- 所有 502 都由跨 realm clone 触发；
- `UND_ERR_CONNECT_TIMEOUT` 必然由 Next.js、undici 或 Response 包装造成；
- 某一账号的卡片错误等同于所有 Provider、所有 API Key 都不可用；
- `9f20e53` 或某个依赖升级已被证明是直接根因。

---

## 3. 证据分级与当前结论

### 3.1 已验证事实（可复现或可由仓库直接确认）

| 编号 | 事实 | 证据 | 结论边界 |
|---|---|---|---|
| F-01 | 原流量监控使用 `new Request(request, { headers })` 克隆请求。 | `6b91063^:src/lib/networkTraffic.js` | 此写法存在跨 realm 风险。 |
| F-02 | 全局 `Request` 克隆独立 undici realm 的 `Request` 可触发 brand check。 | 先前独立复现与回归测试 | 证明代码缺陷存在；不证明任意生产超时都由它导致。 |
| F-03 | `6b91063` 改为使用请求自身构造器，并对 clone 失败回退。 | `src/lib/networkTraffic.js` 与提交 `6b91063` | 修复覆盖了已知的 Request realm 场景。 |
| F-04 | 自动 Ping 由 `quotaAutoPing` 直接调用 `proxyAwareFetch` 或 Codex executor。 | `src/shared/services/quotaAutoPing.js` | 不经过 `/v1` 的 `withNetworkTraffic()` 包装器。 |
| F-05 | 手动账号测试由 `testSingleConnection` 直接调用 `fetch` / `proxyAwareFetch`。 | `src/app/api/providers/[id]/test/testUtils.js` | 不经过 `/v1` 的 `withNetworkTraffic()` 包装器。 |
| F-06 | 从 `6b91063` 到当前 `HEAD`，自动 Ping、账号测试及连接代理源码没有变更。 | `git diff --name-status 6b91063..HEAD --` 对应路径 | 这些路径没有直接源码回归；仍可能受配置、依赖或网络环境影响。 |
| F-07 | `aff0298` 在 `6b91063` 之后再次修改流量监控与关键测试/发布工作流。 | `git show aff0298` | 已知可用基线之后又引入了新的横切变量。 |
| F-08 | `9f20e53` 改变了 API Key 标签参与账号候选池的行为。 | `src/sse/services/auth.js`、`git show 9f20e53` | 同一 Key 可能选择不同账号；需以实际 connection ID 验证影响。 |
| F-09 | 根 `package-lock.json` 被忽略，Dockerfile 和 CI 均允许在无 lockfile 时执行 `npm install`。 | `.gitignore`、`Dockerfile`、`.github/workflows/docker-publish.yml` | 同一源码可解析到不同依赖树。 |
| F-10 | CI 发布检查为模块级 Vitest 测试，未启动与生产相同的容器做真实 HTTP / 上游链路冒烟。 | `.github/workflows/docker-publish.yml` | 不能证明生产请求、代理、账号选择或自动 Ping 可用。 |

### 3.2 运行观察（需保留来源与时间）

| 编号 | 观察 | 来源 | 可信度 |
|---|---|---|---|
| O-01 | 用户确认 `sha-6b91063` / `v0.4.35` 正常。 | 用户反馈，2026-09-08 | 高；但缺少同环境版本清单。 |
| O-02 | 账号卡片显示 `502: fetch failed (cause: UND_ERR_CONNECT_TIMEOUT)`。 | 用户截图，2026-09-08 | 高；只证明该次上游连接超时。 |
| O-03 | 当前仓库没有完整生产日志副本。 | 本地仓库检查 | 高；禁止据此补造精确时间线。 |

### 3.3 未验证假设（排查项，不得当作结论）

| 编号 | 假设 | 为什么可能 | 如何证伪或确认 |
|---|---|---|---|
| H-01 | 发布镜像解析到不同 Next / undici 版本，改变了连接或 realm 行为。 | lockfile 未跟踪且依赖使用 semver 范围。 | 从故障与可用容器采集 `node`、`next`、`undici`、lockfile hash、镜像 digest。 |
| H-02 | 标签优先路由把多个请求集中到某个不可达账号。 | `9f20e53` 改变候选池。 | 记录每个请求选中的 connection ID、标签、代理配置和回退轨迹。 |
| H-03 | 账号代理、DNS、出口网络或上游暂时不可达。 | 错误为连接超时，且自动 Ping/账号测试直连上游。 | 容器内对同一 upstream / proxy 做受控连通性测试并记录 DNS、TCP、TLS 阶段。 |
| H-04 | 流量监控的后续加固引入了新的入口兼容性问题。 | `aff0298` 修改横切层。 | 在同一可复现镜像中，对 `6b91063`、`aff0298`、`9f20e53` 逐个 cherry-pick/二分，执行真实入口冒烟。 |

---

## 4. 调用链边界：为什么不能用相同错误文本直接归因

### 4.1 `/v1` 兼容 API 路径

```text
客户端请求
  -> src/app/api/v1/*/route.js
  -> withNetworkTraffic(request, handler)
  -> src/sse/handlers/*
  -> getProviderCredentials（账号选择）
  -> executor / fetch（上游请求）
```

该路径可能受到跨 realm Request 包装、账号路由、代理和上游连接的共同影响。

### 4.2 手动账号测试路径

```text
Dashboard
  -> POST /api/providers/[id]/test
  -> testSingleConnection()
  -> fetch() 或 proxyAwareFetch()
  -> 上游
```

这条路径不经过 `withNetworkTraffic()`。如果它显示 `UND_ERR_CONNECT_TIMEOUT`，应优先检查上游、代理、DNS、出口网络和账号配置。

### 4.3 配额自动 Ping 路径

```text
后台定时器
  -> runQuotaAutoPingTick()
  -> refreshAndUpdateCredentials()
  -> getUsage()
  -> proxyAwareFetch() / Codex executor
  -> 上游
```

自动 Ping 失败只会写入该任务的 failure cache 和日志；它不是 `/v1` 入口流量监控的证据。

---

## 5. 时间线（仅记录可核实的提交与反馈）

| 时间（Asia/Shanghai） | 事件 | 证据 / 说明 |
|---|---|---|
| 2026-08-26 20:12 | 引入网络流量监控。 | 提交 `442880b`。 |
| 2026-09-07 11:57 | 引入权限标签路由。 | 提交 `702cb32`。 |
| 2026-09-07 12:39 | 发布版本 `0.4.35`。 | 提交 `590136b`。 |
| 2026-09-07 16:36 | 修复已复现的跨 realm Request clone 问题。 | 提交 `6b91063`。 |
| 2026-09-07 18:03 | 对流量监控做二次加固，并新增报告与 CI 检查。 | 提交 `aff0298`。 |
| 2026-09-07 18:04 | 发布版本 `0.4.36`。 | 提交 `7e54cbc`。 |
| 2026-09-08 09:07 | 修正 CI 中 Vitest 的工作目录。 | 提交 `5d3ff98`。 |
| 2026-09-08 11:23 | 引入 API Key 标签优先账号路由。 | 提交 `9f20e53`，版本 `0.4.38`。 |
| 2026-09-08 | 用户反馈请求再次不可用，回退到 `sha-6b91063` 后恢复。 | 用户反馈与截图。 |

未获取生产日志前，不得补充“事故开始 / 发现 / 恢复”的分钟级时间，也不得声称某一提交已在生产中唯一造成该超时。

---

## 6. 根因分类

| 类别 | 已确认问题 | 对重复事故的作用 |
|---|---|---|
| 代码缺陷 | 跨 realm `Request` 克隆可在 handler 前失败。 | 已确认的历史入口风险。 |
| 错误归因 | 相同的 `502` / timeout 文本被当作同一根因。 | 直接导致排查与修复方向偏离。 |
| 变更管理 | 已知可用的 `6b91063` 后又合并横切监控改动和路由改动。 | 增加变量，削弱回归可定位性。 |
| 测试缺口 | 模块测试没有覆盖生产容器、真实 HTTP、账号测试、自动 Ping、代理和实际账号选择。 | 让“测试通过”误被理解为“生产可用”。 |
| 构建不可复现 | 根 lockfile 未跟踪；发布允许 `npm install`。 | 无法保证可用与故障版本的运行时依赖一致。 |
| 环境不一致 | 发布检查 Node 24，Docker 运行 Node 22。 | 对 realm / fetch / undici 类问题尤其危险。 |
| 发布控制缺失 | 无灰度、无部署后自动冒烟、无自动回滚门槛。 | 故障版本可直接影响全部流量。 |
| 可观测性缺失 | 未记录入口阶段、选中账号、代理来源、上游 host、失败阶段和镜像依赖指纹。 | 不能在错误发生后快速区分本地入口、路由和上游网络问题。 |

---

## 7. 已采取的纠正措施

1. **停止将本次 `UND_ERR_CONNECT_TIMEOUT` 直接归因于流量监控。**
2. **撤回未经调用链验证的推测性 Response 包装修改。**
3. **将事故报告改为证据分级结构**，明确 F（事实）、O（观察）、H（假设）。
4. **建立后续规范**：见 [发布与事故响应规范](./RELEASE-AND-INCIDENT-RESPONSE-STANDARD.md)。

以下事项尚未完成，不能在状态中写为“已修复”：根 lockfile 纳入版本控制、强制 `npm ci`、生产镜像依赖指纹、容器级冒烟、灰度发布、自动回滚、请求/账号连接诊断字段。

---

## 8. 再次发布前必须完成的证据采集

对可用基线与故障版本各采集一次，并保存到受控的事故附件目录：

```bash
# 容器构建身份
cat /app/build-info.json
docker inspect --format '{{.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}' spring-mouse

# 运行时与关键依赖（容器内）
node --version
node -p "require('next/package.json').version"
node -p "require('undici/package.json').version"
sha256sum package-lock.json 2>/dev/null || true
```

同时保存下列**脱敏**记录：

- 发生时间、镜像 digest / revision、容器 ID；
- 路径类型：`/v1`、账号测试、自动 Ping、配额刷新；
- Provider、connection ID（可散列）、是否启用代理、代理来源；
- 选中账号与回退次数；
- 上游 host（不含路径参数、Token 或 Authorization）；
- 错误阶段：DNS、TCP connect、TLS、首字节、读取响应、入口包装、路由选择；
- 完整 cause code，例如 `UND_ERR_CONNECT_TIMEOUT`；
- 请求 ID / 流量 ID（如存在）。

禁止记录 API Key、OAuth access token、refresh token、Cookie、完整 Authorization、请求正文或用户提示词。

---

## 9. 关闭条件

本事故只有同时满足以下条件才能标记为“关闭”：

1. 可用和故障镜像的 revision、digest、Node、Next、undici 和 lockfile hash 均已归档；
2. 当前超时被定位为具体调用链与失败阶段，或有明确证据表明无法进一步定位；
3. 根 lockfile 和 `npm ci` 已成为发布强制条件；
4. Docker 运行时的容器级 HTTP 冒烟已在 CI 中通过；
5. 对账号路由、代理、自动 Ping 与 `/v1` 入口有覆盖的测试；
6. 灰度、观察窗口、人工/自动回滚流程已演练；
7. 所有行动项均有负责人、截止日期和验收证据。
