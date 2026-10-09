export const CAPABILITY_PROBE_VERSION = 1;
export const CAPABILITY_EVIDENCE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CAPABILITY_HISTORY_LIMIT = 10;
export const CAPABILITY_TEST_SCOPE = "modelCapabilityTests";
export const CAPABILITY_TESTS = [
  { key: "text", label: "文本响应", quick: true },
  { key: "tools", label: "工具调用", quick: true },
  { key: "vision", label: "图片理解", quick: true },
  { key: "pdf", label: "PDF 理解", quick: true },
  { key: "contextWindow", label: "上下文检索", quick: true },
  { key: "audioInput", label: "音频理解" },
  { key: "videoInput", label: "视频理解" },
  { key: "reasoning", label: "可观测推理输出" },
  { key: "structuredOutput", label: "JSON 结构化输出" },
  { key: "imageOutput", label: "图片生成" },
  { key: "audioOutput", label: "音频生成" },
  { key: "search", label: "原生搜索" },
];
export const QUICK_CAPABILITY_TESTS = CAPABILITY_TESTS.filter((test) => test.quick).map((test) => test.key);
export const CAPABILITY_TEST_LIMITS = Object.freeze({
  outputTokens: 1024,
  responseBytes: 2 * 1024 * 1024,
  mediaResponseBytes: 16 * 1024 * 1024,
  timeoutMs: 60000,
  maxTimeoutMs: 180000,
  maxRunMs: 20 * 60 * 1000,
  leaseMs: 25 * 60 * 1000,
  quickContextTokens: 4096,
  deepContextTokens: 131072,
  maxContextTokens: 1048576,
  maxRequests: 8,
  hardMaxRequests: 16,
  totalInputTokens: 300000,
  hardTotalInputTokens: 2000000,
});
export const CAPABILITY_STATUS_LABELS = {
  supported: "实测支持", unsupported: "明确不支持", unknown: "未能确认", untested: "未测试",
};
