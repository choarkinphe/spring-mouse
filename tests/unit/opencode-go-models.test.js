import { describe, expect, it } from "vitest";
import { PROVIDER_MODELS, getModelSupportedFormats } from "../../open-sse/config/providerModels.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { resolveTransport } from "../../open-sse/services/provider.js";

// Chat-only models (no /messages, no /responses support on opencode-go).
// Facts aligned to the public Go catalog (api key kinds), 2026-11-17 snapshot.
const CHAT_ONLY = ["glm-5.2", "glm-5.3", "glm-5.3-flash", "kimi-k2.7-code", "kimi-k3", "mimo-v2.6-flash", "mimo-v2.6-pro", "deepseek-v4.1-flash", "deepseek-v4-pro"];
// Models that only expose the Anthropic /messages endpoint (no chat-completions)
const CLAUDE_CAPABLE = ["minimax-m3", "qwen3.8-max", "qwen3.8-flash", "qwen3.7-plus", "qwen4-max"];
// Models that only expose the OpenAI /responses endpoint
const RESPONSES_CAPABLE = ["grok-4.7", "gpt-5.6-luna", "gpt-6-luna", "muse-spark-1.3-contributor"];

// Mirror of chatCore's per-model transport guard: use the sourceFormat-matched
// transport only when the model declares support for that sourceFormat.
function pickTransport(provider, sourceFormat, alias, model) {
  const supported = getModelSupportedFormats(alias, model) || PROVIDERS[provider]?.unknownModelFormats;
  const rt = resolveTransport(provider, sourceFormat);
  return supported?.includes(sourceFormat) ? rt : null;
}

// This seed retains protocol metadata only; live discovery/sync is tested in
// opencode-go-model-sync.test.js and must not be constrained to this snapshot.
describe("OpenCode Go known protocol metadata seed", () => {
  it("retains the known model IDs without defining the live directory", () => {
    const ids = (PROVIDER_MODELS["opencode-go"] || []).map((m) => m.id);
    // Snapshot of the public Go catalog (2026-11-17). Stale upstream ids
    // (glm-5.1, kimi-k2.6, minimax-m2.5, qwen3.6-plus, ...) were removed when
    // the catalog dropped them; keep this list aligned on each sync.
    expect(ids).toEqual([
      "deepseek-v4.1-flash", "deepseek-v4-pro",
      "glm-5.2", "glm-5.3", "glm-5.3-flash",
      "grok-4.7",
      "muse-spark-1.2-contributor", "muse-spark-1.3-contributor",
      "gpt-5.6-luna", "gpt-6-luna",
      "claude-haiku-5-5",
      "hy3", "hy4", "hy4-preview",
      "kimi-k2.7-code", "kimi-k3", "kimi-k3.1-pro",
      "mimo-v2.6-flash", "mimo-v2.6-pro",
      "minimax-m3", "minimax-m3.1-flash",
      "longcat-2.0", "longcat-2.5-free",
      "step-5-preview",
      "beam-free", "hy4-flash-free", "iceman-contributor-free",
      "qwen4-max", "qwen3.8-max", "qwen3.8-flash", "qwen3.7-plus",
      "gemini-4-argon",
    ]);
  });
});

describe("OpenCode Go per-model supportedFormats", () => {
  it("declares [claude] for the /messages-only models (MiniMax + Qwen families)", () => {
    for (const m of CLAUDE_CAPABLE) {
      expect(getModelSupportedFormats("opencode-go", m)).toEqual(["claude"]);
    }
  });

  it("declares [openai-responses] for the /responses-only models", () => {
    for (const m of RESPONSES_CAPABLE) {
      expect(getModelSupportedFormats("opencode-go", m)).toEqual(["openai-responses"]);
    }
  });

  it("declares [openai] only for chat-only models (GLM/Kimi/MiMo/DeepSeek) → guards /messages routing", () => {
    for (const m of CHAT_ONLY) {
      expect(getModelSupportedFormats("opencode-go", m)).toEqual(["openai"]);
    }
  });
});

describe("OpenCode Go multi-endpoint transports", () => {
  it("declares openai / claude / openai-responses transports", () => {
    const formats = (PROVIDERS["opencode-go"].transports || []).map((t) => t.format);
    expect(formats).toEqual(["openai", "claude", "openai-responses"]);
  });

  it("resolveTransport picks the endpoint matching the client sourceFormat", () => {
    expect(resolveTransport("opencode-go", "claude").baseUrl).toBe("https://opencode.ai/zen/go/v1/messages");
    expect(resolveTransport("opencode-go", "openai-responses").baseUrl).toBe("https://opencode.ai/zen/go/v1/responses");
    expect(resolveTransport("opencode-go", "openai").baseUrl).toBe("https://opencode.ai/inference/go/openai/v1/chat/completions");
  });

  it("uses x-api-key + anthropicVersion on the claude transport", () => {
    const t = resolveTransport("opencode-go", "claude");
    expect(t.auth.header).toBe("x-api-key");
    expect(t.auth.anthropicVersion).toBe(true);
  });
});

describe("OpenCode Go per-model transport guard (chatCore logic)", () => {
  it("defaults newly discovered IDs to chat instead of assuming Messages/Responses support", () => {
    for (const model of ["deepseek-v4.1-flash", "future-go-model"]) {
      expect(pickTransport("opencode-go", "claude", "opencode-go", model)).toBeNull();
      expect(pickTransport("opencode-go", "openai-responses", "opencode-go", model)).toBeNull();
      expect(pickTransport("opencode-go", "openai", "opencode-go", model)?.baseUrl)
        .toBe("https://opencode.ai/inference/go/openai/v1/chat/completions");
    }
  });
  it("routes MiniMax/Qwen + claude-format client to /messages", () => {
    for (const m of CLAUDE_CAPABLE) {
      expect(pickTransport("opencode-go", "claude", "opencode-go", m)?.baseUrl).toBe("https://opencode.ai/zen/go/v1/messages");
    }
  });

  it("does NOT route chat-only models to /messages on a claude-format request", () => {
    for (const m of CHAT_ONLY) {
      expect(pickTransport("opencode-go", "claude", "opencode-go", m)).toBeNull();
    }
  });

  it("routes DeepSeek + responses-format client to /responses", () => {
    for (const m of RESPONSES_CAPABLE) {
      expect(pickTransport("opencode-go", "openai-responses", "opencode-go", m)?.baseUrl).toBe("https://opencode.ai/zen/go/v1/responses");
    }
  });

  it("does NOT route MiniMax (no responses support) to /responses", () => {
    for (const m of CLAUDE_CAPABLE) {
      expect(pickTransport("opencode-go", "openai-responses", "opencode-go", m)).toBeNull();
    }
  });
});
