import path from "node:path";
if (!path.basename(path.dirname(process.env.DATA_DIR || "")).startsWith("sm-gpt-compat.") || !global.__appBootstrapped) throw new Error("Requires isolated GPT fixture");
const { updateSettings, getProviderConnections, createProviderConnection } = await import("../../../src/lib/db/index.js");
if ((await getProviderConnections()).length) throw new Error("Fixture database must be empty");
await updateSettings({ requireLogin: false, requireApiKey: false, rtkEnabled: false, headroomEnabled: false, pxpipeEnabled: false, cloudEnabled: false, mitmEnabled: false });
await createProviderConnection({ provider: "openai", authType: "apikey", apiKey: "fixture-not-real", name: "Synthetic OpenAI", isActive: true });
await createProviderConnection({ provider: "codex", authType: "oauth", accessToken: "fixture-not-real", name: "Synthetic Codex", isActive: true, expiresAt: new Date(Date.now() + 86400000).toISOString() });
console.log("[gpt-compat] synthetic accounts seeded; no real credentials");
