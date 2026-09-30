// Seed an isolated Spring Mouse data dir for the Claude Desktop smoke fixture.
//
// Creates one OpenAI-compatible node + connection pointing at the local mock
// upstream, one LLM combo, and sets it as the Claude Messages default route.
// Runs against DATA_DIR (set by the caller) so the user's real database is never
// touched. Prints only the non-secret values the smoke script needs.
//
//   DATA_DIR=/tmp/sm-smoke MOCK_PORT=9911 node seed.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

import { writeFile } from "node:fs/promises";

if (!process.env.DATA_DIR || !path.basename(path.dirname(process.env.DATA_DIR)).startsWith("sm-smoke.")) {
  throw new Error("seed requires a fresh sm-smoke.* temporary DATA_DIR");
}

const MOCK_PORT = Number(process.env.MOCK_PORT || 9911);
const COMBO_ID = process.env.SMOKE_COMBO || "deepseek-flash";

const { createProviderNode, createProviderConnection, createCombo, updateSettings, createApiKey } =
  await import(path.join(repoRoot, "src/lib/db/index.js"));

const node = await createProviderNode({
  id: "openai-compatible-chat-smoke",
  type: "openai-compatible",
  name: "Smoke Mock",
  prefix: "smokemock",
  apiType: "chat",
  baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
});

await createProviderConnection({
  provider: node.id,
  authType: "apikey",
  name: "smoke-mock-account",
  apiKey: "sk-mock",
  providerSpecificData: { prefix: node.prefix, baseUrl: node.baseUrl, nodeName: node.name, apiType: "chat" },
});

await createCombo({ name: COMBO_ID, kind: "llm", models: [`${node.prefix}/mock-model`] });
await updateSettings({ claudeMessagesRoute: COMBO_ID, requireApiKey: true, requireLogin: false });
const key = await createApiKey("smoke-only", "smoke-machine");
await writeFile(path.join(process.env.DATA_DIR, "smoke-key.json"), JSON.stringify({ key: key.key }), { mode: 0o600 });

console.log(JSON.stringify({ comboId: COMBO_ID, nodePrefix: node.prefix, mockBaseUrl: node.baseUrl }));
