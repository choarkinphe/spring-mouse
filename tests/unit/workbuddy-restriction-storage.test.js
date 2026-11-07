import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
const previousDir = process.env.DATA_DIR;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sm-wb-restricted-"));
process.env.DATA_DIR = dir;
delete global._dbAdapter;
vi.mock("next/server", () => ({ NextResponse: { json: (body, init) => Response.json(body, init) } }));
let repo, PUT, auth;
beforeAll(async () => {
  repo = await import("../../src/lib/db/repos/connectionsRepo.js");
  ({ PUT } = await import("../../src/app/api/providers/[id]/route.js"));
  auth = await import("../../src/sse/services/auth.js");
});
afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(dir, { recursive: true, force: true });
  if (previousDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDir;
});
const put = (id, body) => PUT(new Request(`http://localhost/api/providers/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

describe("persistent WorkBuddy account restriction", () => {
  it("requires reauthorization instead of selecting an active migrated credential", async () => {
    const saved = await repo.createProviderConnection({ provider: "workbuddy", name: "synthetic-legacy", authType: "oauth", accessToken: "legacy-synthetic", isActive: true, providerSpecificData: { workbuddyLegacyCredential: true } });
    expect(await auth.getProviderCredentials("workbuddy", null, "any-model")).toMatchObject({ reauthorizationRequired: true });
    expect((await repo.getProviderConnectionById(saved.id)).accessToken).toBe("legacy-synthetic");
    await repo.deleteProviderConnection(saved.id);
  });
  it("survives generic enable/test/refresh writes and only an explicit recovery clears it", async () => {
    const connection = await repo.createProviderConnection({ provider: "workbuddy", authType: "oauth", name: "synthetic-restriction-test", accessToken: "synthetic", isActive: true });
    const raw = JSON.stringify({ code: 11140, msg: "restricted" });
    await auth.markAccountUnavailable(connection.id, 403, raw, "workbuddy", "model-a", null, { body: raw, source: "http", status: 403, message: "restricted" });
    await repo.updateProviderConnection(connection.id, { isActive: true, accountRestriction: null, testStatus: "active", lastError: null, accessToken: "refreshed-synthetic" });
    let stored = await repo.getProviderConnectionById(connection.id);
    expect(stored).toMatchObject({ isActive: false, accountRestriction: { code: 11140 }, testStatus: "unavailable", lastError: "restricted" });
    expect(await repo.getProviderConnections({ provider: "workbuddy", isActive: true })).toEqual([]);
    expect(await auth.getProviderCredentials("workbuddy", null, "another-model")).toBeNull();
    expect((await put(connection.id, { isActive: true })).status).toBe(200);
    expect((await repo.getProviderConnectionById(connection.id)).isActive).toBe(false);
    expect((await put(connection.id, { recoverRestriction: true })).status).toBe(400);
    const recovered = await put(connection.id, { recoverRestriction: true, isActive: true });
    expect(recovered.status).toBe(200);
    stored = await repo.getProviderConnectionById(connection.id);
    expect(stored).toMatchObject({ isActive: true, accountRestriction: null, testStatus: "active", lastUpstreamRaw: raw });
    await repo.deleteProviderConnection(connection.id);
  });
});
