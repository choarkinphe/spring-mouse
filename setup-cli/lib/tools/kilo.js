// Kilo Code — 写 ~/.local/share/kilo/auth.json + VS Code settings.json
import path from "path";
import { home, readJson, writeJson, withV1, LEGACY_NAMES } from "../util.js";

const dataDir = () => path.join(home(), ".local", "share", "kilo");
const authPath = () => path.join(dataDir(), "auth.json");
const vscodeSettingsPath = () => path.join(home(), ".config", "Code", "User", "settings.json");

export async function status() {
  const auth = await readJson(authPath());
  const configured = !!(auth?.["spring-mouse"] || auth?.["9router"] || auth?.["openai-compatible"]);
  return {
    tool: "kilo",
    name: "Kilo Code",
    settingsFile: authPath(),
    configured,
    endpoint: auth?.["openai-compatible"]?.baseUrl || null,
  };
}

export async function apply({ endpoint, key, model }) {
  if (!endpoint || !key || !model) throw new Error("--endpoint、--key、--model 必填");

  const auth = (await readJson(authPath())) || {};
  auth["openai-compatible"] = {
    type: "api-key",
    apiKey: key,
    baseUrl: withV1(endpoint),
    model,
  };
  await writeJson(authPath(), auth);

  // 尽力更新 VS Code 扩展设置
  let vscodeFile = null;
  try {
    const vscode = (await readJson(vscodeSettingsPath())) || {};
    vscode["kilocode.customProvider"] = { name: "Spring Mouse", baseURL: withV1(endpoint), apiKey: key };
    vscode["kilocode.defaultModel"] = model;
    await writeJson(vscodeSettingsPath(), vscode);
    vscodeFile = vscodeSettingsPath();
  } catch { /* VS Code 设置不可写时忽略 */ }

  return { file: authPath(), vscodeFile };
}

export async function reset() {
  const auth = await readJson(authPath());
  if (auth) {
    delete auth["openai-compatible"];
    delete auth["9router"];
    delete auth["spring-mouse"];
    await writeJson(authPath(), auth);
  }
  try {
    const vscode = await readJson(vscodeSettingsPath());
    if (vscode) {
      delete vscode["kilocode.customProvider"];
      delete vscode["kilocode.defaultModel"];
      await writeJson(vscodeSettingsPath(), vscode);
    }
  } catch { /* ignore */ }
  return { file: authPath() };
}
