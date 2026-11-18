import { platform, arch } from "os";

// === OS/Arch helpers (Stainless fingerprint) ===
export function mapStainlessOs() {
  switch (platform()) {
    case "darwin": return "MacOS";
    case "win32": return "Windows";
    case "linux": return "Linux";
    case "freebsd": return "FreeBSD";
    default: return `Other::${platform()}`;
  }
}

export function mapStainlessArch() {
  switch (arch()) {
    case "x64": return "x64";
    case "arm64": return "arm64";
    case "ia32": return "x86";
    default: return `other::${arch()}`;
  }
}

// Anthropic API version (single source — reused across claude-format providers/executors)
export const ANTHROPIC_API_VERSION = "2023-06-01";

// Shared Claude-compatible API headers (reused across claude-format providers)
export const CLAUDE_API_HEADERS = {
  "Anthropic-Version": ANTHROPIC_API_VERSION,
  "Anthropic-Beta": "claude-code-20250219,interleaved-thinking-2025-05-14"
};

// Full Claude CLI fingerprint — required by providers that gate on client identity (e.g. agentrouter).
// Captured from a clean Claude Code 2.1.327 (`claude -p`, entrypoint sdk-cli) on
// 2026-11-18. The SDK sends no X-Stainless-Helper-Method and asks for JSON even
// when the body requests a stream.
export const CLAUDE_CODE_VERSION = "2.1.327";
export const CLAUDE_CLI_SPOOF_HEADERS = {
  "Accept": "application/json",
  "Anthropic-Version": ANTHROPIC_API_VERSION,
  "Anthropic-Beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,advanced-tool-use-2025-11-20,effort-2025-11-24,extended-cache-ttl-2025-04-11",
  "Anthropic-Dangerous-Direct-Browser-Access": "true",
  "User-Agent": `claude-cli/${CLAUDE_CODE_VERSION} (external, sdk-cli)`,
  "X-App": "cli",
  "X-Stainless-Retry-Count": "0",
  "X-Stainless-Runtime-Version": "v26.12.1",
  "X-Stainless-Package-Version": "0.128.0",
  "X-Stainless-Runtime": "node",
  "X-Stainless-Lang": "js",
  "X-Stainless-Arch": mapStainlessArch(),
  "X-Stainless-Os": mapStainlessOs(),
  "X-Stainless-Timeout": "600"
};

// Claude Code 2.1.327 sends the same flag set for haiku, sonnet and opus; only
// the position of claude-code-20250219 differs. OAuth adds oauth-2025-04-20 and
// extended-cache-ttl-2025-04-11. Per-request extras the CLI toggles itself
// (thinking-token-count-2026-05-13) are left out.
const ANTHROPIC_BETA_SHARED = [
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
];
const ANTHROPIC_BETA_TAIL = [
  "per-turn-control-2026-07-01",
  "mid-conversation-tool-changes-2026-07-01",
  "advanced-tool-use-2025-11-20",
  "effort-2025-11-24",
];

export function selectAnthropicBeta(model = "", { oauth = true } = {}) {
  const head = oauth
    ? (/^claude-haiku/.test(model)
      ? ["oauth-2025-04-20", ...ANTHROPIC_BETA_SHARED, "claude-code-20250219"]
      : ["claude-code-20250219", "oauth-2025-04-20", ...ANTHROPIC_BETA_SHARED])
    : ["claude-code-20250219", ...ANTHROPIC_BETA_SHARED];
  return [...head, ...ANTHROPIC_BETA_TAIL, ...(oauth ? ["extended-cache-ttl-2025-04-11"] : [])].join(",");
}

// Shared baseUrls
export const KIMI_CODING_BASE_URL = "https://api.kimi.com/coding/v1/messages";

// Default base for dynamic compat providers (openai-compatible-* / anthropic-compatible-*) when user gives no baseUrl
export const OPENAI_COMPAT_BASE = "https://api.openai.com/v1";
export const ANTHROPIC_COMPAT_BASE = "https://api.anthropic.com/v1";

// Official Antigravity IDE Desktop 2.1.1 fingerprint captured from macOS arm64.
// Keep this static even when spring-mouse runs on Linux: the provider profile is
// intentionally matching the IDE client, not the server host.
export const ANTIGRAVITY_IDE_VERSION = "2.1.1";
export const ANTIGRAVITY_IDE_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_IDE_USER_AGENT = `antigravity/ide/${ANTIGRAVITY_IDE_VERSION} darwin/arm64`;

// Authorization, token exchange, and refresh must use the same deployed client.
export const ANTIGRAVITY_OAUTH_CLIENT = {
  clientId: process.env.ANTIGRAVITY_OAUTH_CLIENT_ID?.trim() || "",
  clientSecret: process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET?.trim() || ""
};

// Gemini (Google) OAuth client credentials (public CLI client — shared by gemini, gemini-cli, src/lib/oauth)
export const GOOGLE_OAUTH_CLIENT = {
  clientId: process.env.GEMINI_OAUTH_CLIENT_ID || "",
  clientSecret: process.env.GEMINI_OAUTH_CLIENT_SECRET || ""
};
