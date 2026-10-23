import path from "node:path";
if (!process.env.DATA_DIR || !path.basename(path.dirname(process.env.DATA_DIR)).startsWith("sm-opencode-go.")) {
  throw new Error("Seed requires isolated sm-opencode-go.* DATA_DIR");
}
const { createProviderConnection, addCustomModel, syncCustomModels, upsertModelCapabilities, updateSettings } = await import("../../../src/lib/db/index.js");
await createProviderConnection({ provider: "opencode-go", authType: "apikey", name: "Go catalog fixture", apiKey: "sk-fixture-not-real", priority: 1, isActive: true });
await syncCustomModels([
  { providerAlias: "ocg", providerId: "opencode-go", id: "deepseek-v4-flash", source: "official" },
  { providerAlias: "ocg", providerId: "opencode-go", id: "glm-5.1", source: "static" },
]);
await addCustomModel({ providerAlias: "ocg", id: "manual-keep", name: "Manual model (must survive sync)" });
await syncCustomModels([{ providerAlias: "ocg", providerId: "opencode-go", id: "deepseek-v4.1-flash", source: "official", capabilities: {} }]);
await upsertModelCapabilities({ providerAlias: "ocg", providerId: "opencode-go", id: "deepseek-v4.1-flash", capabilities: { vision: true } });
await updateSettings({ requireLogin: false, requireApiKey: false, rtkEnabled: false, headroomEnabled: false, pxpipeEnabled: false });
console.log("Seeded isolated OpenCode Go catalog fixture");
