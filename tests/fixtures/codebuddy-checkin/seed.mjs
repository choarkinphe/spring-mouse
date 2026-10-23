import path from "node:path";
import os from "node:os";

const root = path.dirname(process.env.DATA_DIR || "");
if (!path.basename(root).startsWith("sm-codebuddy-checkin.")
    || ![os.tmpdir(), "/tmp"].map((dir) => path.resolve(dir)).includes(path.dirname(path.resolve(root)))
    || process.env.DATA_DIR !== path.join(root, "data")
    || process.env.HOME !== path.join(root, "home")) {
  throw new Error("Seed requires temporary sm-codebuddy-checkin.* DATA_DIR and HOME");
}
if (!global.__appBootstrapped) throw new Error("Seed requires fixture preload to suppress host bootstrap and real egress");

// Use the real SQLite repository via ../claude-desktop-smoke/register.mjs.
const { createProviderConnection, getProviderConnections, updateSettings } = await import("../../../src/lib/db/index.js");
if ((await getProviderConnections()).length) throw new Error("Seed requires an empty fixture database; restart start.sh for a fresh run");
const common = {
  provider: "codebuddy-cn",
  authType: "oauth",
  accessToken: "fixture-access-not-real",
  refreshToken: "fixture-refresh-not-real",
  expiresAt: new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
  expiresIn: 7 * 86400,
  isActive: true,
};
const account = await createProviderConnection({
  ...common,
  name: "WorkBuddy 签到演示（模拟账号）",
  priority: 1,
  providerSpecificData: { codebuddyUid: "fixture-user" },
});
const missingUid = await createProviderConnection({
  ...common,
  name: "WorkBuddy 缺少 UID（错误验证）",
  priority: 2,
});
await updateSettings({
  requireLogin: false, requireApiKey: false,
  rtkEnabled: false, headroomEnabled: false, pxpipeEnabled: false,
  mitmEnabled: false, cloudEnabled: false,
});
console.log(JSON.stringify({ fixture: "codebuddy-checkin", accountId: account.id, missingUidAccountId: missingUid.id }));
