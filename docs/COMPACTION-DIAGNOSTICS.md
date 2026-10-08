# 压缩请求专用诊断

只观察，不改变自动压缩窗口、输出预算、路由、账号选择、重试或回退。

## 识别范围

- Claude Code 请求标记：`x-cc-compaction-request` / `x-claude-code-compaction`（大小写无关）。
- Codex Responses compact：`/responses/compact` 路径或已有 `_compact:true` 内部标记。
- **不**把 `x-cc-context-compacted` / `x-claude-code-context-compacted` 当成压缩请求，它们表示后续会话已压缩。
- **不**通过提示词“请总结”等文本猜测。不记录标记Header值。客户端若不发送标记，本诊断不能凭空确认普通Messages请求是压缩。

## 日志

`COMPACTION-DIAG | {...}` 使用 `errorLine`，生产WARN级别可见。

- `dispatch`：客户端与翻译后的请求结构。
- `headers`：上游HTTP状态与执行器返回的最终请求结构（有提供时）。
- `end`：上游拒绝、执行器错误、取消、JSON响应准备完成或流结束回调。结束只输出一次。

`response_complete` / `stream_usage_complete` 只说明生命周期回调执行，**不证明客户端已成功保存压缩边界**，也不替代routingAttempts的协议终止分类。未观测到上游终止时不得以HTTP200认定摘要压缩成功。

关联：网关`requestId`、`trafficRequestId`（仅UUID），上游错误中的UUID请求号；账号、渠道、模型均只保留SHA256前16位以和相同对象对照，不记录邮箱、自定义名称或原始会话号。

结构：消息/角色/已知block类型数量，观察到的文字字符数（**不是token数**），工具数和tool-call数量，stream、max_tokens / max_completion_tokens / max_output_tokens，已知thinking类型及预算、reasoning effort、temperature/top_p。未知标签统一other。

错误：只提取数值code、白名单嵌套错误码（如11133/model_param_invalid、11115/400003）、HTTP状态、UUID上游请求号；错误消息和正文不复制。

边界：最多扫描10000条消息、20000个内容块；超出时sampled=true。字符串只读length，工具schema不遍历，body不序列化/复制或保留在长生命周期闭包。错误JSON最多解析16000字符。任何诊断异常或logger失败均fail-open。

## 判断示例

1. dispatch存在但headers缺失：优先查执行器/网络失败或取消，不归因上游400。
2. headers400、end/upstream_rejected、code11133：上游参数拒绝；对比同账号成功请求的数量/预算/thinking形态，不直接判定窗口不支持1M。
3. headers200后stream_error/client_abort：流生命周期失败，不能归为参数错误。
4. 新摘要成功与旧摘要失败的预算/角色/block结构不同：形成假设，再用专用隔离账号最小验证；不要自动重放生产大上下文。

本诊断不新增数据库字段，不把记录返回调用方、不主动发压缩请求。普通请求不输出COMPACTION-DIAG。服务器现有其他错误日志/明细保存逻辑不在本补丁范围，不能把本日志的脱敏保证扩展为全系统保证。
