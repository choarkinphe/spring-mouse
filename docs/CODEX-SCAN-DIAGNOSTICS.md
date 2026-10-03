# Codex 首输出扫描诊断

`CODEX-SCAN | { ... }` 是观察日志，不改变输出检测、扫描阈值、重试或模型回退规则。

- 扫描仍在运行时，30 秒输出一次进度快照。
- 扫描结束时输出一次最终快照，包括正常放行、上游错误和网关扫描中止。
- 使用 `errorLine`，在生产 `LOG_LEVEL=WARN` 下可见。
- `scanId` 区分并发扫描，`connectionId` 为内部账号 UUID，`attempt` 为执行器尝试序号；不记录邮箱、Key、提示词、工具参数、正文或思考内容。

## 判断方式

| 字段 | 含义 |
|---|---|
| `eventCounts` | 完整 SSE 帧的 JSON `type`，缺失时使用 event 头 |
| `eventHeaderCounts` | 实际 event 头计数，可与 JSON type 对照 |
| `chunks` / `bytes` / `frames` | 已读 chunk、字节、完整 SSE 帧数量 |
| `lastChunkAfterMs` / `lastChunkAgeMs` | 最后收包距扫描开始的时间，以及快照时多久没收包 |
| `firstOutputType` / `firstOutputAfterMs` | 原有检测器首次判定输出的类型及时间 |
| `firstCandidateType` / `firstCandidateAfterMs` | 独立观察器首次看到输出候选的类型及时间 |
| `candidateWithoutDetection` | 有内容候选，但旧检测器尚未判定输出；是疑似漏识别线索，不是自动修改规则的依据 |
| `malformedFrames` / `oversizedFrames` | JSON 无法解析、超过诊断保留上限的帧数 |
| `pendingFrameChars` | 尚未完整结束的 SSE 帧长度 |
| `releaseReason` | preamble / request / scan-ceiling / bytes / eof / terminal / output-grace / read-error / upstream-error |

候选检测只看顶层 delta、text、arguments、refusal，以及明确的 done-item / content-part 输出字段。不检查 `response.created` 回显的 instructions 或 tools。

已知事件名使用固定协议白名单；未知名称统一记为 `other`，避免上游把敏感文本放进事件标签而被原样记录。诊断帧最多保留 512 Ki 字符，超限只计数并恢复到下一帧；大帧、未知事件或缺少完整帧时，不能仅凭 `candidateWithoutDetection: false` 排除漏识别。

典型结果：

1. 只有 created / in_progress、candidateFrames=0、长时间没收包：扫描内没有观察到完整输出候选；不等于证明 OpenAI 内部原因。
2. 有 refusal / output_item.done / other 候选，candidateWithoutDetection=true：优先检查现有检测器是否漏了这种输出形态。
3. firstOutputType 为 reasoning/text/tool delta，outputDetected=true：已识别输出，后续故障应查流转换或客户端可见输出阶段。

网关扫描中止时，结构化 `scanDiagnostics` 附在错误证据对象中；持久化账号摘要仍沿用现有字段。完整诊断主要从服务器日志读取。本次不扩展 DB schema，也不把诊断正文返回到调用方。
