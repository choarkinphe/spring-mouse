import { HARNESS_MODEL_OPTIONS, isValidHarnessMatch } from "./harnessRoute.js";

function clientModelId(model, family) {
  const raw = typeof model === "string" ? model : model?.id;
  if (typeof raw !== "string" || (model?.type && model.type !== "llm")
    || (model?.kind && model.kind !== "llm")) return null;
  const id = raw.replace(/^(?:anthropic|openai|claude|codex)\//, "");
  if (!isValidHarnessMatch(id) || id.includes("/") || id.includes("*")) return null;
  if (!id.startsWith(family === "claude" ? "claude-" : "gpt-")) return null;
  if (/(?:^|-)(?:image|audio|realtime|embedding|tts|transcribe|search)(?:-|$)/i.test(id)) return null;
  return id;
}

// Compare versions within a family naturally (5-10 > 5-5, 6.1 > 6), without
// treating every dated Anthropic alias as a newer generation than an undated id.
export function sortHarnessModelIds(ids) {
  return [...new Set(ids)].sort((a, b) => {
    const family = (id) => id.match(/^(claude-[a-z]+|gpt)-/)?.[1] || id;
    const versioned = (id) => /^\d/.test(id.slice(family(id).length + 1));
    return family(a).localeCompare(family(b))
      || Number(versioned(b)) - Number(versioned(a))
      || b.localeCompare(a, "en", { numeric: true });
  });
}

export function buildHarnessModelHints({ claude = [], codex = [], local = [] } = {}) {
  const collect = (family, entries) => sortHarnessModelIds(
    entries.map((model) => clientModelId(model, family)).filter(Boolean),
  );
  const claudeIds = collect("claude", [
    ...claude, ...local, ...HARNESS_MODEL_OPTIONS["claude-code"],
  ]);
  return {
    "claude-desktop": claudeIds,
    "claude-code": claudeIds,
    codex: collect("gpt", [...codex, ...local, ...HARNESS_MODEL_OPTIONS.codex]),
  };
}
