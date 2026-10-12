# JevAPI / TypeSafe System One

Jev 是结构化决策模型，不生成聊天文本。Spring Mouse 保留原生 `state + questions → answers` 协议，通过 `POST /v1/systemone` 提供服务，不将它转换为 Chat Completions，也不把它当作聊天路由的候选模型。

## 配置

1. 在 [TypeSafe Console](https://console.typesafe.ai/) 获取 API Key（上游可能需要开通 early access）。
2. 打开 **媒体服务 → 决策能力 → JevAPI**，添加连接并填入 TypeSafe API Key。
3. 验证密钥并同步模型。验证使用 `GET https://api.typesafe.ai/v1/models`，不会提交收费的决策请求。
4. 客户端调用 Spring Mouse 的 `/v1/systemone`。客户端传 **Spring Mouse API Key**，上游 TypeSafe Key 保存在通道账号中。

模型支持原生名称（例如 `jev-latest`），也支持限定通道的 `jevapi/jev-latest`。转发时移除通道前缀。上游模型列表为准；官方文档当前列出 `jev-latest`、`jev-preview`，也允许固定版本 `jev-1.13.0`。

## 调用权限标签

在 **媒体服务 → 决策能力 → JevAPI → JevAPI 调用权限** 中配置允许调用的 Key 权限标签并保存，例如 `jev-users`、`admin`。然后到 **集成与凭据** 给允许调用的 Spring Mouse API Key 分配相应标签。

- 命中任意一个允许标签即可通过接口级权限检查，还须通过现有 Key 有效性、额度和模型权限检查。
- 配置非空时，未带 Key / 无效 Key 返回 `401`，有效但无匹配标签的 Key 返回 `403`，不会发起上游调用。
- 清空列表意味着不增加接口级标签限制，保留原有鉴权行为；不会清空 Key 标签或模型权限。
- 策略保存在 `settings.systemoneAccessTags`，涵盖全部 System One 模型和账号，包括后续新增账号。模型前缀、别名不影响这项检查。
- 标签只从服务端 Key 配置读取，请求正文或自定义请求头声明标签不能授权。
- 保存后对新请求生效，无需重启；不会取消已经进入上游执行的请求。

## 调用示例

```bash
curl http://localhost:8008/v1/systemone -H "Authorization: Bearer $SPRING_MOUSE_API_KEY" -H "Content-Type: application/json" -d '{"model":"jevapi/jev-latest","state":"客户的付款已连续三天失败，需要紧急处理。","questions":{"urgent":{"type":"noul","instructions":"这是否需要紧急处理？"},"team":{"type":"choice","instructions":"哪个团队应该处理？","criteria":{"billing":"付款、账单或退款","technical":"软件缺陷或故障"}},"severity":{"type":"score","instructions":"问题有多严重？","criteria":["轻微","中等","严重"]}}}'
```

成功响应保留上游的 `model`、`answers`（概率分布、置信度和评分图例）和 `usage`。网关将 `input_tokens` / `output_tokens` 记录到用量中。该接口是非流式 JSON，不支持 `stream: true`、图片、音频或视频输入。

网关复用 API Key 权限、额度及通道账号选择。可切换账号的上游错误由已有账号策略处理，每个账号在单次请求中最多尝试一次。上游 `Retry-After` 用于账号冷却并保留在错误响应；不会无间隔重试同一账号。客户端仍应针对 `429` / `529` 使用带退避的重试。上游原生 JSON 错误（包括 `422` 的字段明细）不会转换成聊天响应。

## 本地验证

- 单元测试：在 `tests/` 中运行 `npx vitest run unit/systemone.test.js unit/systemone-handler.test.js`。
- Desktop Preview：选择 `.claude/launch.json` 中的 `jevapi-fixture`。统一启动脚本先启动模拟上游，再启动网关，并检查双方 readiness；使用临时 `HOME` / `DATA_DIR`，不会读写真实账户或调用上游计费接口。
- Preview URL：`http://127.0.0.1:8037/dashboard/media-providers?kind=systemone&provider=jevapi`。
- 模拟账号密钥仅用于测试：`fixture-jevapi-key`。非本地网络请求被测试 preload 阻止，TypeSafe 请求被重定向到本地模拟服务。

## 本次验证结果

- 16 个相关测试文件、201 项测试全部通过；包含原生协议、鉴权/账号切换、模型列表、校验失败状态和既有模型/嵌入回归。
- 隔离 Preview 自动烟测通过：新建与已存密钥验证、模型列表与同步入库、三种原生问题、裸模型名与通道前缀、无效请求和聊天误调用拒绝。
- 浏览器实际点击“同步模型”成功，显示上游两个模型，未显示聊天测试按钮。原生请求返回 HTTP 200；用量记录 318 input / 34 output，按参考价格计算费用为 $0.000013356。
- 新增核心代码 lint 与 `git diff --check` 通过。现有 ModelsCard / 媒体页面的三个 `react-hooks/set-state-in-effect` lint 错误已在未修改 HEAD 核实存在。
- 全部 unit 测试的一次运行仍有 87 项失败，不能称为全套通过。provider/alias 静态快照也有旧漂移（在干净 HEAD 核实），本次未重写基线来掩盖差异。
- 全新隔离数据库的日志出现已有 `usageRollupDay` 表缺失提示；请求用量明细仍成功入库，本次未扩大范围修改数据库迁移。
- 未提供真实 TypeSafe API Key，因此未执行真实上游计费请求；没有提交、推送或部署。

## 官方依据

- [JevAPI 介绍](https://jevapi.dev/)
- [TypeSafe API reference](https://docs.typesafe.ai/api)
- [TypeSafe models](https://docs.typesafe.ai/models)

协议与模型信息核对日期：2026-10-12。没有真实 TypeSafe Key 时，只能验证模拟上游与本地网关，不能宣称已完成真实账户端到端验证。
