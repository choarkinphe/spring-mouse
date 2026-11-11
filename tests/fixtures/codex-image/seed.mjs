import path from "node:path";
if (!path.basename(path.dirname(process.env.DATA_DIR || "")).startsWith("sm-codex-image.") || !global.__appBootstrapped) throw new Error("Requires isolated Codex image fixture");
const { createProviderConnection, getProviderConnections, updateSettings, addCustomModel } = await import("../../../src/lib/db/index.js");
if ((await getProviderConnections()).length) throw new Error("Fixture database must be empty");
for (const id of ["a", "b"]) {
  await createProviderConnection({ provider: "codex", authType: "oauth", name: `模拟 Plus 账号 ${id.toUpperCase()}`, accessToken: `fixture-${id}`, refreshToken: `fixture-refresh-${id}`, expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(), isActive: true, lastRefreshAt: new Date().toISOString(), priority: id === "a" ? 1 : 2, providerSpecificData: { chatgptAccountId: `fixture-account-${id}` } });
}
await addCustomModel({ providerAlias: "cx", id: "gpt-5.5-image", type: "image" });
await updateSettings({ requireLogin: false, requireApiKey: false, rtkEnabled: false, headroomEnabled: false, pxpipeEnabled: false, cloudEnabled: false, mitmEnabled: false });
console.log("Seeded isolated Codex image accounts (no real credentials)");
