import path from "node:path";
if (!process.env.DATA_DIR || !path.basename(path.dirname(process.env.DATA_DIR)).startsWith("sm-combo-search.") || process.env.HOME !== path.join(path.dirname(process.env.DATA_DIR), "home")) {
  throw new Error("Seed requires isolated sm-combo-search.* DATA_DIR and HOME");
}
const { createProviderNode, createProviderConnection, syncCustomModels, updateSettings, createCombo } = await import("../../../src/lib/db/index.js");
const provider = "openai-compatible-chat-combo-search-fixture";
const prefix = "combo-search-fixture";
const baseUrl = `http://127.0.0.1:${process.env.MOCK_PORT || 9067}/v1`;
await createProviderNode({ id: provider, type: "openai-compatible", name: "Combo search fixture (local only)", prefix, apiType: "chat", baseUrl });
await createProviderConnection({ provider, authType: "apikey", name: "Fixture model (fake key)", apiKey: "sk-fixture-model-only", priority: 1, providerSpecificData: { baseUrl, prefix, apiType: "chat" } });
await syncCustomModels([{ providerAlias: provider, providerId: provider, id: "search-model", type: "llm", source: "official", capabilities: { tools: true, vision: false, contextWindow: 32000 } }]);
await createProviderConnection({ provider: "deepseek", authType: "apikey", name: "Fixture search (fake key)", apiKey: "sk-fixture-deepseek-only", priority: 1 });
await createCombo({ name: "combo-search-preview", kind: "llm", models: [`${prefix}/search-model`], search: { mode: "gateway", provider: "deepseek", maxResults: 5 } });
await updateSettings({ requireLogin: false, requireApiKey: false, rtkEnabled: false, headroomEnabled: false, pxpipeEnabled: false });
console.log("Seeded isolated combo-search fixture with fake model/search credentials");
