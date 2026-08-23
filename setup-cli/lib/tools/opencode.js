// OpenCode — 写 ~/.config/opencode/opencode.json 的 provider 段
import path from "path";
import { home, readJson, writeJson, withV1, PROVIDER_ID, LEGACY_IDS } from "../util.js";

const configDir = () => path.join(home(), ".config", "opencode");
const configPath = () => path.join(configDir(), "opencode.json");

export async function status() {
  const config = await readJson(configPath());
  const provider = LEGACY_IDS.map((id) => config?.provider?.[id]).find(Boolean);
  return {
    tool: "opencode",
    name: "OpenCode",
    settingsFile: configPath(),
    configured: !!provider,
    endpoint: provider?.options?.baseURL || null,
  };
}

export async function apply({ endpoint, key, model, models, subagentModel }) {
  const modelList = Array.isArray(models) ? models : String(models || model || "").split(",").map((m) => m.trim()).filter(Boolean);
  if (!endpoint || modelList.length === 0) throw new Error("--endpoint 和 --model（或 --models）必填");

  const file = configPath();
  const config = (await readJson(file)) || {};
  const base = withV1(endpoint);
  const keyToUse = key || "sk_spring_mouse";
  const sub = subagentModel || modelList[0];

  config.provider = config.provider || {};
  // 兼容迁移：旧 9router 段改名
  if (config.provider["9router"] && !config.provider[PROVIDER_ID]) {
    config.provider[PROVIDER_ID] = config.provider["9router"];
    delete config.provider["9router"];
  }
  const provider = config.provider[PROVIDER_ID] || { npm: "@ai-sdk/openai-compatible", options: {}, models: {} };
  provider.options = { ...(provider.options || {}), baseURL: base, apiKey: keyToUse };
  provider.models = provider.models || {};
  for (const m of modelList) {
    provider.models[m] = { name: m, modalities: { input: ["text", "image"], output: ["text"] } };
  }
  config.provider[PROVIDER_ID] = provider;
  config.model = `${PROVIDER_ID}/${modelList[0]}`;
  if (sub) config.agent = { ...(config.agent || {}) };

  await writeJson(file, config);
  return { file, models: modelList };
}

export async function reset() {
  const file = configPath();
  const config = await readJson(file);
  if (!config) return { file, note: "无配置" };
  LEGACY_IDS.forEach((id) => {
    if (config.provider) delete config.provider[id];
  });
  if (config.model && config.model.startsWith(`${PROVIDER_ID}/`)) delete config.model;
  await writeJson(file, config);
  return { file };
}
