import path from "node:path";
if (!path.basename(path.dirname(process.env.DATA_DIR || "")).startsWith("sm-corecode-image.") || !global.__appBootstrapped) throw new Error("Requires isolated CoreCode fixture");
const { createProviderConnection, getProviderConnections, updateSettings } = await import("../../../src/lib/db/index.js");
if ((await getProviderConnections()).length) throw new Error("Fixture database must be empty");
await createProviderConnection({ provider: "corecode", authType: "apikey", name: "CoreCode fixture", apiKey: "fixture-not-real", isActive: true });
await updateSettings({ requireLogin: false, requireApiKey: false, rtkEnabled: false, headroomEnabled: false, pxpipeEnabled: false, cloudEnabled: false, mitmEnabled: false });
console.log("Seeded isolated CoreCode fixture without real credentials");
