# 生产事故报告：网络流量监控导致 API 请求全局异常

- **事故日期**：2026 年 9 月 7 日
- **事故等级**：S1 / 高优先级
- **影响范围**：所有接入网络流量监控包装器的 API 请求路径
- **影响时长**：约 1 小时（以生产监控和业务方反馈为准）
- **根因状态**：已确认并修复
- **报告版本**：1.0

## 1. 摘要

2026 年 9 月 7 日，系统更新后多个 Provider 和 API 路径同时出现请求失败，站点受到约 1 小时影响。排查确认，网络流量监控功能在业务 handler 执行之前对请求进行包装。原实现使用全局 `Request` 构造器复制 Next.js 路由收到的请求，在 Next.js dev/Turbopack 场景下触发了不同 `undici` realm 之间的私有字段 brand check，导致请求包装阶段抛出异常。

由于监控包装器覆盖了聊天、Embedding、音频、视频、图片、搜索、模型列表等多个入口，异常发生在业务处理之前，最终表现为多条 API 路径同时失败。截图中观察到的 `502: fetch failed` 与 `UND_ERR_CONNECT_TIMEOUT` 是对外可见的下游连接错误表现；该信息单独不能证明每一个 502 都来自 realm 异常，但代码复现和调用链分析确认原请求克隆实现存在足以造成全局故障的缺陷。

## 2. 用户影响

受影响期间，用户可能遇到以下现象：

- 聊天请求、Responses 请求和 Messages 请求失败；
- Embeddings、图片、音频、视频、搜索和 Web Fetch 请求失败；
- Provider 状态面板显示多个账号同时异常；
- 部分请求被记录为 500/502，无法进入实际 Provider 选择和转发逻辑；
- usage、网络流量和请求来源关联数据可能不完整。

本事故没有证据表明 API Key、OAuth token 或 Provider 凭证发生泄露。监控逻辑本身没有读取或记录请求 body，也没有改变凭证存储内容。

## 3. 时间线

以下时间为仓库提交时间（Asia/Shanghai），不等同于完整生产监控时间线：

| 时间 | 事件 |
|---|---|
| 2026-08-26 20:12 | 提交 `442880b` 引入网络流量监控，并将包装器接入多条 API 路由。 |
| 2026-09-07 11:57 | 提交 `702cb32` 增加权限标签路由能力。 |
| 2026-09-07 12:39 | 提交 `590136b` 将版本升级到 `0.4.35`。 |
| 2026-09-07 16:36 | 提交 `6b91063` 首次修复跨 realm Request 克隆问题。 |
| 2026-09-07 17:xx | 完成跨 realm、请求体、空响应和关联 ID 回归验证，并补充 fail-open 防护。 |

生产事故的准确开始时间、发现时间和恢复时间应以部署平台、网关和应用日志补充确认；当前仓库中没有完整的生产日志副本，因此不对具体分钟级时间做臆测。

## 4. 技术根因

### 4.1 原始实现

原实现使用了跨 realm 的拷贝构造：

```js
const headers = new Headers(request.headers);
headers.set(TRAFFIC_REQUEST_ID_HEADER, requestId);
return new Request(request, { headers });
```

在 Next.js dev/Turbopack 下，进入路由的 `NextRequest` 底层可能来自 Next 自己打包的 `undici.Request`，而业务代码解析到的全局 `Request` 来自另一个类或另一个 realm。两个对象即使 API 外观相同，也不共享相同的私有字段品牌。

`undici` 在拷贝构造过程中访问私有字段 `#state`。当传入的对象不是当前构造器所属类的实例时，会触发 brand check 并抛出异常，例如：

```text
Cannot read private member #state
```

### 4.2 为什么会造成全局影响

`withNetworkTraffic()` 的执行顺序为：

1. 生成流量请求 ID；
2. 统计请求 body 大小；
3. 克隆并注入流量 ID；
4. 调用实际业务 handler。

原实现第 3 步失败后直接抛错，第 4 步不会执行。因此网络流量统计这个附加功能成为核心请求链路的硬依赖。

同时，该包装器被接入了多类 API 路由，所以错误不是单个 Provider 的局部问题，而是具有横向放大效应的入口级故障。

### 4.3 独立复现

在当前 Node 环境中，使用全局 `Request` 和独立导入的 `undici.Request` 验证：

- `new Request(undiciRequest, { headers })` 失败；
- `new undiciRequest.constructor(undiciRequest, { headers })` 成功；
- POST body 可以完整读取并透传。

该复现证明，原实现并非理论风险，而是可触发的运行时兼容性问题。

## 5. 修复措施

### 5.1 使用请求自身的构造器

文件：`src/lib/networkTraffic.js`

现在使用：

```js
const RequestCtor = request?.constructor;
const cloned = new RequestCtor(request, { headers });
```

并验证克隆结果确实拥有可用的 `headers.get()` 方法，避免自定义或异常构造器返回无效对象。

### 5.2 WeakMap 兜底关联

当请求无法重新包装时，系统继续使用原始请求，并在 `WeakMap` 中保存请求对象到 traffic ID 的映射。`getTrafficRequestId()` 在请求头中不存在 ID 时，会回查该映射。

这样即使克隆降级，以下调用方仍可获得正确的关联 ID：

- `src/sse/services/ingressUsage.js`
- `src/sse/handlers/embeddings.js`

### 5.3 监控逻辑 fail-open

以下监控失败不会再阻断业务请求：

- 请求 URL 解析失败；
- 请求 body 大小读取失败；
- Request 克隆失败；
- 请求来源元数据读取失败；
- Response 不属于全局 Response realm；
- Response body 为空。

监控数据在异常情况下允许降级为 `0`、`unknown` 或空元数据，但业务请求必须继续执行。

### 5.4 Response realm 兼容

不仅 Request 可能跨 realm，Response 也可能来自另一个 `undici` 实例。现在不再仅使用：

```js
response instanceof Response
```

而是使用结构判断，并优先使用 response 自身的构造器包装流，兼容不同 realm 的 Response。

### 5.5 限制降级日志

Request 克隆降级会输出一次诊断日志，包含构造器名称和错误原因，但不会输出请求 body、API Key 或 token，避免高并发时日志爆量和敏感信息泄露。

### 5.6 测试 mock 同步

权限标签功能新增了 `resolveApiKeyAccessTags` 后，部分旧测试 mock 未同步导出该方法，导致测试集合出现额外失败。本次一并修正：

- `tests/unit/embedding-usage-persistence.test.js`
- `tests/unit/fetch-success-clears-account.test.js`
- `tests/unit/xai-video-handler.test.js`

## 6. 验证结果

### 6.1 事故相关回归测试

以下测试全部通过：

```text
Test Files  5 passed
Tests       30 passed
```

覆盖内容包括：

- 普通 Request 和独立 `undici.Request`；
- POST JSON body 透传；
- ReadableStream body 和流式 Response；
- Request 构造失败后的 WeakMap 兜底；
- 独立 `undici.Response`；
- 204 空响应；
- ingress usage traffic ID 关联；
- embeddings usage 持久化；
- fetch 和视频处理路径。

### 6.2 构建与静态检查

- `npm run build`：通过；
- ESLint：通过；
- `node --check src/lib/networkTraffic.js`：通过；
- `git diff --check`：通过。

### 6.3 完整单元测试

当前完整单元测试结果：

```text
1673 tests
1558 passed
91 failed
24 skipped
```

剩余失败主要来自仓库中与本事故无直接关系的既有问题，包括 Cursor agent 导出、CLI 构建产物、Headroom 环境依赖、历史测试路径和部分过期断言。事故相关的关键路径测试已单独验证为 30/30 通过。

## 7. 根因分类

| 类别 | 问题 | 责任层级 |
|---|---|---|
| 代码缺陷 | 使用全局 Request 对象跨 realm 拷贝 | 直接根因 |
| 架构缺陷 | 监控失败可以阻断业务请求 | 放大因素 |
| 测试缺口 | 未覆盖 Next/Turbopack 与独立 undici realm | 逃逸原因 |
| 发布缺口 | 横切所有 API 路由的基础设施改动缺少灰度验证 | 放大因素 |
| 依赖治理 | `package-lock.json` 被忽略，依赖存在漂移风险 | 潜在风险 |
| 测试治理 | 完整单元测试存在较多历史失败，降低红灯信噪比 | 潜在风险 |

## 8. 后续改进计划

### P0：保持监控 fail-open

- 所有日志、流量统计、审计和指标代码必须不能阻断主请求；
- 对新增加的请求包装器执行失败注入测试；
- 禁止在入口处无保护地调用跨 runtime 对象构造器。

### P0：建立真实运行时测试矩阵

至少覆盖：

- Node 22 和 Node 24；
- Next.js dev + Turbopack；
- Next.js production standalone；
- Bun runtime；
- 全局 Request/Response；
- 独立 `undici.Request/Response`；
- POST body、ReadableStream body、GET/HEAD 空 body；
- 204 和流式 Response。

### P1：发布前执行关键入口冒烟

已在 `.github/workflows/docker-publish.yml` 增加发布前检查，覆盖：

- `network-traffic.test.js`；
- `ingress-usage.test.js`；
- `embedding-usage-persistence.test.js`；
- `fetch-success-clears-account.test.js`；
- `xai-video-handler.test.js`。

后续应进一步加入真实启动后的 HTTP 冒烟请求，而不仅是模块级测试。

### P1：固定构建依赖

建议：

1. 将根目录 `package-lock.json` 纳入版本控制；
2. CI 使用 `npm ci`；
3. 固定 Node.js 主版本；
4. 固定 Next.js 和关键 runtime 依赖小版本；
5. 依赖升级单独进行兼容性验证。

### P1：增加入口级监控和告警

建议增加以下指标：

- Request clone fallback 次数；
- 监控包装器异常次数；
- API 入口 5xx 比率；
- Provider 下游超时次数；
- 业务 handler 实际进入率；
- 全 Provider 同时异常告警。

告警应区分“本地入口故障”和“Provider 下游故障”，避免把两类问题混合展示。

### P2：灰度发布和自动回滚

横切 API 基础设施变更应采用：

1. 单实例或小比例灰度；
2. `/v1/models`、`/v1/embeddings`、`/v1/chat/completions` 真实请求验证；
3. 观察 5 分钟错误率、延迟和连接超时；
4. 指标正常后再全量发布；
5. 全局 5xx 超过阈值时自动回滚。

### P2：清理完整测试集历史失败

完整测试集仍有 91 个失败，虽然多数与本事故无关，但会显著降低回归发现能力。应按模块清理：

- 修正测试 mock 与生产导出不一致；
- 修正错误的测试路径；
- 补齐 CLI 构建产物；
- 隔离环境依赖型测试；
- 删除或更新过期行为断言；
- 让 CI 对关键路径和全量测试分别报告。

## 9. 当前状态

- 代码修复：已完成；
- 事故相关回归测试：30/30 通过；
- 构建：通过；
- 发布前关键测试门禁：已加入；
- 生产发布：需要在合并后按灰度流程执行；
- 本报告：已保存到项目文档目录。

## 10. 结论

本次事故不是单个 Provider 凭证或网络线路的局部故障，而是一个横切请求入口的基础设施兼容性缺陷。根本教训是：

> 跨 realm 的 Web API 对象不能使用全局构造器做品牌相关的复制；监控和审计逻辑必须 fail-open；横切基础设施改动必须在真实运行时完成入口级灰度验证。
