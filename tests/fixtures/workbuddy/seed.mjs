import path from "node:path";
if (!path.basename(path.dirname(process.env.DATA_DIR || "")).startsWith("sm-workbuddy.") || !global.__appBootstrapped) throw new Error("Requires isolated WorkBuddy fixture");
const { updateSettings, getProviderConnections, createProviderConnection } = await import("../../../src/lib/db/index.js");
if ((await getProviderConnections()).length) throw new Error("Fixture database must be empty");

// Rows shaped exactly like the production database BEFORE the replacement:
// legacy provider ids, CodeBuddy credentials, CN carries codebuddyUid.
await createProviderConnection({
  provider: "codebuddy-cn", authType: "oauth", name: "旧 CN 账号（迁移前）",
  accessToken: "legacy-cn-access-not-real", refreshToken: "legacy-cn-refresh-not-real",
  expiresIn: 30 * 86400, isActive: true, providerSpecificData: { codebuddyUid: "legacy-cn-uid" },
});
await createProviderConnection({
  provider: "codebuddy-intl", authType: "oauth", name: "旧 国际 账号（迁移前）",
  accessToken: "legacy-intl-access-not-real", refreshToken: "legacy-intl-refresh-not-real",
  expiresIn: 365 * 86400, isActive: true, providerSpecificData: {},
});
await updateSettings({ requireLogin: false, requireApiKey: false, rtkEnabled: false, headroomEnabled: false, pxpipeEnabled: false, cloudEnabled: false, mitmEnabled: false });

// Reproduce the real upgrade order: the rows exist on disk, and THEN the
// migration runs. Without this the fixture would only prove that brand-new
// legacy-named rows stay unmigrated, which is not what production does.
const { getAdapter } = await import("../../../src/lib/db/driver.js");
const migration = (await import("../../../src/lib/db/migrations/027-codebuddy-to-workbuddy.js")).default;
migration.up(await getAdapter());
const after = await getProviderConnections();
console.log(JSON.stringify({ migrated: after.map((c) => ({ provider: c.provider, name: c.name, legacy: c.providerSpecificData?.workbuddyLegacyCredential === true })) }));
