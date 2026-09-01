export const CUSTOM_CHANNEL_ICON_OPTIONS = [
  { id: "openai", label: "OpenAI", src: "/providers/openai.svg" },
  { id: "anthropic", label: "Anthropic", src: "/providers/anthropic.png" },
  { id: "gemini", label: "Gemini", src: "/providers/gemini.png" },
  { id: "deepseek", label: "DeepSeek", src: "/providers/deepseek.png" },
  { id: "qwen", label: "通义千问", src: "/providers/qwen.png" },
  { id: "glm", label: "智谱 GLM", src: "/providers/glm-cn.png" },
  { id: "kimi", label: "Kimi", src: "/providers/kimi.png" },
  { id: "minimax", label: "MiniMax", src: "/providers/minimax.png" },
  { id: "grok", label: "Grok", src: "/providers/xai.png" },
  { id: "mistral", label: "Mistral", src: "/providers/mistral.png" },
  { id: "cohere", label: "Cohere", src: "/providers/cohere.png" },
  { id: "ollama", label: "Ollama", src: "/providers/ollama.png" },
  { id: "openrouter", label: "OpenRouter", src: "/providers/openrouter.png" },
  { id: "siliconflow", label: "硅基流动", src: "/providers/siliconflow.png" },
  { id: "nvidia", label: "NVIDIA", src: "/providers/nvidia.png" },
  { id: "groq", label: "Groq", src: "/providers/groq.png" },
  { id: "together", label: "Together AI", src: "/providers/together.png" },
  { id: "fireworks", label: "Fireworks AI", src: "/providers/fireworks.png" },
  { id: "cerebras", label: "Cerebras", src: "/providers/cerebras.png" },
  { id: "huggingface", label: "Hugging Face", src: "/providers/huggingface.png" },
  { id: "perplexity", label: "Perplexity", src: "/providers/perplexity.png" },
];

const LEGACY_CUSTOM_CHANNEL_ICON_SRCS = {
  "/providers/openai.png": "/providers/openai.svg",
};

export function normalizeCustomChannelIconSrc(src) {
  if (typeof src !== "string") return "";
  const normalizedSrc = LEGACY_CUSTOM_CHANNEL_ICON_SRCS[src] || src;
  return CUSTOM_CHANNEL_ICON_OPTIONS.some((icon) => icon.src === normalizedSrc) ? normalizedSrc : "";
}

export function isCustomChannelIconSrc(src) {
  return Boolean(normalizeCustomChannelIconSrc(src));
}
