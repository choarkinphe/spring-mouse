// Claude Code — 写 ~/.claude/settings.json 的 env 段
import fs from "fs/promises";
import path from "path";
import { home, readJson, writeJson, withV1 } from "../util.js";

const settingsPath = () => path.join(home(), ".claude", "settings.json");

const RESET_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "API_TIMEOUT_MS",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
];

export async function status() {
  const settings = await readJson(settingsPath());
  const env = settings?.env || {};
  return {
    tool: "claude",
    name: "Claude Code",
    settingsFile: settingsPath(),
    configured: !!env.ANTHROPIC_BASE_URL,
    endpoint: env.ANTHROPIC_BASE_URL || null,
  };
}

export async function apply({ endpoint, key, opusModel, sonnetModel, haikuModel }) {
  if (!endpoint || !key) throw new Error("--endpoint 和 --key 必填");
  const file = settingsPath();
  const current = (await readJson(file)) || {};

  const env = {
    ANTHROPIC_BASE_URL: withV1(endpoint),
    ANTHROPIC_AUTH_TOKEN: key,
    API_TIMEOUT_MS: "600000",
  };
  if (opusModel) env.ANTHROPIC_DEFAULT_OPUS_MODEL = opusModel;
  if (sonnetModel) env.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnetModel;
  if (haikuModel) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = haikuModel;

  const next = {
    ...current,
    hasCompletedOnboarding: true,
    env: { ...(current.env || {}), ...env },
  };
  await writeJson(file, next);
  return { file, env };
}

export async function reset() {
  const file = settingsPath();
  const current = await readJson(file);
  if (!current) return { file, note: "无配置文件" };
  if (current.env) {
    RESET_ENV_KEYS.forEach((k) => delete current.env[k]);
    if (Object.keys(current.env).length === 0) delete current.env;
  }
  await writeJson(file, current);
  return { file };
}
