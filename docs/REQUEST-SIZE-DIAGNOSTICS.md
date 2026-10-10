# Codex 请求大小诊断

`REQUEST-SIZE | {...}` 仅观察，不改变大小限制、路由、账号冷却、重试次数或输出预算。当前仅对Codex渠道启用，避免无关Provider每次发送产生额外日志。

## 计量位置

BaseExecutor调用transformRequest后，使用**实际送给proxyAwareFetch或Mouse任务的同一个JSON字符串**计量：`Buffer.byteLength(bodyStr, 'utf8')`。不重新序列化body。

- `requestBytes`：完整序列化请求体的精确UTF-8字节数（不包括HTTP headers、传输压缩、TLS开销）。
- `requestChars`：同一字符串的UTF-16长度，非ASCII时与字节数不同。
- `inputItems` / `tools`：最终上游输入条目数、工具数。
- `images` / `imageStringBytes`：观察到的图片块数及图片URL/base64字符串UTF-8字节数；不包括JSON字段名/转义开销。
- `textStringBytes`：被扫描输入内容文字字符串字节数，不是token，也不含所有可能嵌套字段。
- `instructionsChars` / `instructionsBytes`：最终instructions长度，不记录指令内容。
- `sampled`：输入/内容块计数是否达到有界扫描上限。组件计数可能不完整，但requestBytes仍为完整请求体精确值。

已在发送前移除/转换的图片、工具或内容不会按客户端原样计入。字段数量不代表模型上下文token数，不能把bytes当tokens。

## 关联

- `sendId`：每次HTTP/Mouse发送独立UUID。
- `requestId`：来自chatCore的模型调用UUID，同一请求账号回退保持相同ID；请求另有routingAttempt条目区分账号。
- `accountHash` / `providerHash` / `modelHash`：SHA256前16位，不记录账号邮箱/模型自定义字符串。
- `urlIndex` / `retry`：BaseExecutor本轮URL索引和HTTP重试序号。Codex SSE级重试再次进入BaseExecutor时此序号重置，应结合sendId、requestId和既有Codex retry日志判断，不误称整个请求重试总数。
- `transport`：http或mouse。Mouse记录为Spring组装的任务请求体，节点上游发送如另有处理不能凭此保证完全相同。

## 阶段

`send`在发送前记录；`response_headers`记录相同大小及HTTP状态；`fetch_error`只记录aborted/transport_error分类，不复制异常正文。日志使用errorLine，在生产WARN级别可见；logger失败不阻断业务。

HTTP507分析：按requestId把507那次sendId/accountHash的requestBytes与后续成功账号发送比较。如果同一体积能在另一账号正常完成，只能说上游某次缓冲/重试限制触发，不能直接断言模型token窗口不支持该请求。没有上游明确阈值时不要根据单样本设新限制。

不记录body、提示词、图片数据、工具schema/arguments、Token或Header值；不新增DB字段、不自动重放请求。旧明细_originalSize=保存预算+1不是实际大小，使用新诊断取证下一次事件，不能补算历史截断记录。
