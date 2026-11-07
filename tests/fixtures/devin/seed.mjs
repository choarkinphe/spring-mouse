import path from "node:path";
if (!path.basename(path.dirname(process.env.DATA_DIR || "")).startsWith("sm-devin.") || !global.__appBootstrapped) throw new Error("Requires isolated Devin fixture");
const { createProviderConnection, getProviderConnections, updateSettings } = await import("../../../src/lib/db/index.js");
if ((await getProviderConnections()).length) throw new Error("Fixture database must be empty");
await createProviderConnection({ provider: "devin", authType: "oauth", name: "Devin 模拟账号（非真实连接）", accessToken: "fixture-devin-not-real", email: "devin-fixture@example.invalid", isActive: true, testStatus: "active" });
await updateSettings({ requireLogin: false, requireApiKey: false, rtkEnabled: false, headroomEnabled: false, pxpipeEnabled: false, cloudEnabled: false, mitmEnabled: false });
console.log("Seeded isolated Devin fixture; synthetic credentials only");
