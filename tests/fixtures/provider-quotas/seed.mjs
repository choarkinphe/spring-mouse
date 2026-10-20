import path from "node:path";
if (!process.env.DATA_DIR || !path.basename(path.dirname(process.env.DATA_DIR)).startsWith("sm-provider-quotas.")) throw new Error("Seed requires an isolated provider quotas DATA_DIR");
const { createProviderConnection, createApiKey, updateSettings } = await import("../../../src/lib/db/index.js");
const providers = [
  { provider: "opencode-go", authType: "apikey", name: "OpenCode Go" },
  { provider: "codex", authType: "oauth", name: "Codex" },
  { provider: "qoder", authType: "oauth", name: "Qoder" },
  { provider: "deepseek", authType: "apikey", name: "DeepSeek" },
];
for (const item of providers) await createProviderConnection({ ...item, apiKey: item.authType === "apikey" ? "fixture-not-real" : undefined, accessToken: item.authType === "oauth" ? "fixture-not-real" : undefined, priority: 1, isActive: true });
await createApiKey("Provider quota fixture", "fixture-machine-id");
await updateSettings({ requireLogin: false, requireApiKey: false, rtkEnabled: false, headroomEnabled: false, pxpipeEnabled: false, enableGlobalUsage: true });
console.log("Seeded isolated provider quota fixture");
