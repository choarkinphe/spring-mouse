// Wire values verified against router-for-me/CLIProxyAPI (MIT), commit
// c2f402b45643f0740d70b9010fd7d8d0aab7ef65, devin_wire.go / devin_executor.go.
export const DEVIN = Object.freeze({
  provider: "devin",
  baseUrl: "https://server.codeium.com",
  chatPath: "/exa.api_server_pb.ApiServerService/GetChatMessage",
  clientName: "devin-cli",
  extensionName: "chisel",
  clientVersion: "3000.11.3",
  minimumSampling: 1e-6,
  gzipRequestThreshold: 8 << 10,
  safeToolId: /^[A-Za-z0-9_-]+$/,
  toolIdPrefix: "dv_",
  noResult: "Tool use was interrupted and did not produce a result.",
  toolImageFrom: "[From the result of ",
  toolImageNote: /(?:\n\n)?\[The tool returned (an image; it|(\d+) images; they) follows? in the next message\.\]$/,
  jsonObjectInstruction: "Respond with a single JSON object and nothing else.",
  jsonSchemaInstruction: "Respond with a single JSON value and nothing else, matching this JSON schema:\n",
  locale: "en",
  sessionTokenPrefix: "devin-session-token$",
  rawJwtPrefix: "eyJ",
  fingerprintHexLength: 732,
  defaultMaxTokens: 128000,
  defaultModel: "swe-2-high",
  maxFrameBytes: 16 * 1024 * 1024,
  maxDecompressedBytes: 64 * 1024 * 1024,
  maxProtobufFields: 100000,
  maxToolCalls: 128,
  maxSessionCounters: 5000,
  maxCompletionBytes: 64 * 1024 * 1024,
  // Quota resets may be hours away; do not poll them using transient backoff.
  maxQuotaCooldownMs: 24 * 60 * 60 * 1000,
  quotaResetPattern: /your limit will reset\s+(?:in\s+([^().]+))?(?:\s*\(?at\s+(\d{1,2}):(\d{2})\s+UTC\)?)?/i,
  contentType: "application/connect+proto",
  flags: Object.freeze({ data: 0, compressed: 1, end: 2 }),
  source: Object.freeze({ user: 1, assistant: 2, tool: 4 }),
  completion: Object.freeze({ enabled: 1, parameter3: 400, topK: 40, temperature: 1, topP: Math.fround(0.95) }),
  thread: Object.freeze({ kind: 4, userBoundary: 14 }),
  effortOrder: Object.freeze(["minimal", "low", "medium", "high", "xhigh", "max"]),
  stopReasons: Object.freeze({ incomplete: 1, stop: 2, maxTokens: 3, endTurn: 4, toolCalls: 10, contentFilter: 11 }),
  trailerStatuses: Object.freeze({ invalid_argument: 400, internal: 502, unauthenticated: 401, permission_denied: 403, resource_exhausted: 429, unavailable: 503, canceled: 499, deadline_exceeded: 504, failed_precondition: 400 }),
});

// Only documented aliases; unknown model UIDs are sent unchanged, not guessed.
export const DEVIN_MODEL_ALIASES = Object.freeze({
  "claude-haiku-4-5": "MODEL_PRIVATE_11",
  "gpt-4-1": "MODEL_CHAT_GPT_4_1_2025_04_14",
});
export const DEVIN_EXPLICIT_EFFORT = /(?:-(?:none|minimal|low|medium|high|xhigh|max|fast|slow|priority|thinking)(?:-(?:1m|fast|priority|lightning))?|_(?:none|minimal|low|medium|high|xhigh|max|thinking))$/i;
