// Cline (VS Code) — 写 ~/.cline/data/globalState.json + secrets.json
import path from "path";
import { home, readJson, writeJson, withoutV1 } from "../util.js";

const dataDir = () => path.join(home(), ".cline", "data");
const globalStatePath = () => path.join(dataDir(), "globalState.json");
const secretsPath = () => path.join(dataDir(), "secrets.json");

export async function status() {
  const state = await readJson(globalStatePath());
  return {
    tool: "cline",
    name: "Cline",
    settingsFile: globalStatePath(),
    configured: state?.actModeApiProvider === "openai" && !!state?.openAiBaseUrl,
    endpoint: state?.openAiBaseUrl || null,
  };
}

export async function apply({ endpoint, key, model }) {
  if (!endpoint || !key || !model) throw new Error("--endpoint、--key、--model 必填");

  const state = (await readJson(globalStatePath())) || {};
  // Cline 要求不带 /v1 的裸地址
  const base = withoutV1(endpoint);
  state.actModeApiProvider = "openai";
  state.planModeApiProvider = "openai";
  state.openAiBaseUrl = base;
  state.openAiModelId = model;
  state.planModeOpenAiModelId = model;
  await writeJson(globalStatePath(), state);

  const secrets = (await readJson(secretsPath())) || {};
  secrets.openAiApiKey = key;
  await writeJson(secretsPath(), secrets);

  return { file: globalStatePath(), secretsFile: secretsPath() };
}

export async function reset() {
  const state = await readJson(globalStatePath());
  if (state) {
    if (state.actModeApiProvider === "openai") {
      delete state.openAiBaseUrl;
      delete state.openAiModelId;
      delete state.planModeOpenAiModelId;
      state.actModeApiProvider = "cline";
      state.planModeApiProvider = "cline";
    }
    await writeJson(globalStatePath(), state);
  }
  const secrets = await readJson(secretsPath());
  if (secrets) {
    delete secrets.openAiApiKey;
    await writeJson(secretsPath(), secrets);
  }
  return { file: globalStatePath() };
}
