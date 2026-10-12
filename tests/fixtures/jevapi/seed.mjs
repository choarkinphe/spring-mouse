import path from "node:path";
if (!process.env.DATA_DIR || !path.basename(path.dirname(process.env.DATA_DIR)).startsWith("sm-jevapi.")) throw new Error("Seed requires isolated sm-jevapi.* DATA_DIR");
const { createProviderConnection, updateSettings } = await import("../../../src/lib/db/index.js");
await createProviderConnection({ provider: "jevapi", authType: "apikey", name: "JevAPI fixture", apiKey: "fixture-jevapi-key", priority: 1 });
await updateSettings({ requireLogin: false, requireApiKey: false, rtkEnabled: false, headroomEnabled: false, pxpipeEnabled: false });
console.log("Seeded isolated JevAPI fixture");
