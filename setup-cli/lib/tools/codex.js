// Codex CLI — 写 ~/.codex/config.toml + auth.json（TOML 处理依赖 confbox）
import fs from "fs/promises";
import path from "path";
import { home, readJson, writeJson, withV1, PROVIDER_ID, PROVIDER_NAME, LEGACY_IDS } from "../util.js";
import { parseTOML, stringifyTOML } from "confbox";

const codexDir = () => path.join(home(), ".codex");
const configPath = () => path.join(codexDir(), "config.toml");
const authPath = () => path.join(codexDir(), "auth.json");

function setNested(obj, dottedKey, value) {
  const keys = dottedKey.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== "object") cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

function deleteNested(obj, dottedKey) {
  const keys = dottedKey.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    cur = cur?.[keys[i]];
    if (cur == null) return;
  }
  delete cur[keys[keys.length - 1]];
}

async function readToml(file) {
  try {
    return parseTOML(await fs.readFile(file, "utf-8")) ?? {};
  } catch {
    return {};
  }
}

export async function status() {
  const content = await readToml(configPath());
  const configured = LEGACY_IDS.some(
    (id) => content?.model_provider === id || content?.model_providers?.[id]
  );
  return {
    tool: "codex",
    name: "Codex CLI",
    settingsFile: configPath(),
    configured,
    endpoint: content?.model_providers?.[PROVIDER_ID]?.base_url || null,
  };
}

export async function apply({ endpoint, key, model, subagentModel }) {
  if (!endpoint || !key || !model) throw new Error("--endpoint、--key、--model 必填");
  await fs.mkdir(codexDir(), { recursive: true });

  const parsed = await readToml(configPath());
  parsed.model = model;
  parsed.model_provider = PROVIDER_ID;
  setNested(parsed, `model_providers.${PROVIDER_ID}`, {
    name: PROVIDER_NAME,
    base_url: withV1(endpoint),
    wire_api: "responses",
  });
  setNested(parsed, "agents.subagent", { model: subagentModel || model });
  await fs.writeFile(configPath(), stringifyTOML(parsed));

  const auth = (await readJson(authPath())) || {};
  auth.OPENAI_API_KEY = key;
  auth.auth_mode = "apikey";
  await writeJson(authPath(), auth);

  return { file: configPath(), authFile: authPath() };
}

export async function reset() {
  const file = configPath();
  const parsed = await readToml(file);
  LEGACY_IDS.forEach((id) => deleteNested(parsed, `model_providers.${id}`));
  if (LEGACY_IDS.includes(parsed?.model_provider)) delete parsed.model_provider;
  await fs.writeFile(file, stringifyTOML(parsed));
  return { file };
}
