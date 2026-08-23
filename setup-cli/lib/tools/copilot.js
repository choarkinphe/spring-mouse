// GitHub Copilot (VS Code) — 写 chatLanguageModels.json 的自定义模型条目
import path from "path";
import os from "os";
import { home, readJson, writeJson, LEGACY_NAMES } from "../util.js";

function configPath() {
  const h = home();
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || h, "Code", "User", "chatLanguageModels.json");
  }
  if (process.platform === "darwin") {
    return path.join(h, "Library", "Application Support", "Code", "User", "chatLanguageModels.json");
  }
  return path.join(h, ".config", "Code", "User", "chatLanguageModels.json");
}

export async function status() {
  const file = configPath();
  const config = await readJson(file);
  const entry = Array.isArray(config)
    ? LEGACY_NAMES.map((n) => config.find((e) => e?.name === n)).find(Boolean)
    : null;
  return {
    tool: "copilot",
    name: "GitHub Copilot (VS Code)",
    settingsFile: file,
    configured: !!entry,
    endpoint: entry?.models?.[0]?.url || null,
  };
}

export async function apply({ endpoint, key, models }) {
  const modelList = (Array.isArray(models) ? models : String(models || "").split(",")).map((m) => m.trim()).filter(Boolean);
  if (!endpoint || modelList.length === 0) throw new Error("--endpoint 和 --models 必填（逗号分隔）");

  const file = configPath();
  let config = await readJson(file);
  if (!Array.isArray(config)) config = [];

  const entryName = "Spring Mouse";
  const url = `${withoutTrailingV1(endpoint)}/chat/completions#models.ai.azure.com`;
  const newEntry = {
    name: entryName,
    vendor: "azure",
    apiKey: key || "sk_spring_mouse",
    models: modelList.map((id) => ({
      id,
      name: id,
      url,
      toolCalling: true,
      vision: false,
      maxInputTokens: 128000,
      maxOutputTokens: 16000,
    })),
  };

  const idx = config.findIndex((e) => LEGACY_NAMES.includes(e?.name));
  if (idx >= 0) config[idx] = newEntry;
  else config.push(newEntry);
  await writeJson(file, config);
  return { file, models: modelList };
}

function withoutTrailingV1(url) {
  return url.endsWith("/v1") ? url.slice(0, -3) : url;
}

export async function reset() {
  const file = configPath();
  const config = await readJson(file);
  if (!Array.isArray(config)) return { file, note: "无配置" };
  const next = config.filter((e) => !LEGACY_NAMES.includes(e?.name));
  await writeJson(file, next);
  return { file };
}
