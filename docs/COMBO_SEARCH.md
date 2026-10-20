# 组合绑定联网搜索

LLM 组合可绑定一个专用搜索通道，由网关注入 `spring_mouse_web_search` function、执行搜索并回填结果。它不是模型的原生搜索能力；例如 Flash 可通过网关搜索获得联网信息，无需把模型本身标为 `search: true`。

## 配置

1. 在通道管理中配置专用搜索服务的凭据（支持 DeepSeek 独立 Search API 及已有 dedicated search providers）。
2. 打开路由策略 → 组合设置，开启「网关联网搜索」，选择专用搜索通道并保存。
3. 至少保留一个支持工具调用的模型节点。搜索绑定会继承到嵌套组合，外层绑定优先。

管理 API：

```json
{
  "search": {
    "mode": "gateway",
    "provider": "deepseek",
    "maxResults": 5
  }
}
```

`PUT /api/combos/:id` 省略 `search` 会保留旧配置；显式 `search: null` 关闭。旧组合默认关闭。配置中不能传入任意 URL、凭据或 provider 别名。每次最多返回 5 条结果。

`/v1/models` 对绑定搜索的组合发布 `capabilities.search: true`，不会公开绑定通道或凭据。客户端不一定识别此扩展字段；但绑定启用后，网关即会向模型提供可选搜索函数，模型按需调用。`tool_choice: "none"` 禁用当次搜索。

## 运行行为

- 支持 Chat Completions、Messages、Responses 请求，以及各自的 JSON / SSE 输出。
- 组合支持回退、轮询、自动路由；绑定搜索的融合策略明确返回错误，尚未实现 panel/judge 搜索语义。
- 筛选工具调用模型，并沿用当前 API Key 的账号权限标签、取消信号、账号刷新和回退逻辑。
- 搜索错误以安全的工具结果回填，不能伪造搜索成功；错误不会被当成聊天模型账号故障。
- 搜索轮次内部采用非流式生成，最终 SSE 是缓冲后的协议化输出，首字延迟较高，不是逐 token 实时透传。未绑定搜索的请求保持原行为。
- 累计各轮生成的用量；每轮实际模型调用仍按原用量记录计量。搜索服务另有上游按次费用。
- 最多 4 轮搜索、8 次工具调用；工具结果压缩截断，每项工具结果最多 8 KiB，总计最多 64 KiB。整个循环受请求 deadline 与 120 秒上限约束。
- 保留客户端自定义工具。若同一响应同时调用客户端工具和网关搜索，优先返回客户端工具，不执行本轮搜索，不建立隐藏跨请求工具历史。

## 首版限制

- 仅支持 `gateway` 搜索模式；未实现 DeepSeek 原生 Responses `web_search` transport。
- 不支持将另一个搜索组合绑定为目标，也不支持仅 `searchViaChat` 的 provider。
- 不支持 Responses `previous_response_id`、历史 `web_search_call`、Chat 多候选 `n > 1`，会明确返回 400。
- 可将裸 hosted `web_search` 声明替换为网关函数；带域名过滤、地区、隐私开关、次数等限制的 hosted 声明会明确返回 400，避免忽略限制后扩大搜索范围。
- `spring_mouse_web_search` 为保留工具名，客户端不得定义同名工具。
- 其他协议入口（如 Gemini 原生请求）暂不支持绑定搜索，会明确拒绝，而不是静默取消搜索。

## 验证

`tests/fixtures/combo-search/start.sh` 是隔离启动入口，Preview 配置名 `combo-search-fixture`。它使用独立 HOME / DATA_DIR / Next 输出目录、模拟模型和搜索服务，拒绝非本地网络请求，不使用真实凭据或付费搜索。

启动后自动验证管理 API 保存，以及 Chat / Responses / Messages 的 JSON、SSE 六种搜索闭环。单元与集成覆盖位于 `tests/unit/combo-search-*.test.js`、`deepseek-search.test.js`。
