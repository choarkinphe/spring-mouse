import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let db;
let mousesRepo;
let connectionsRepo;
let localDb;
let dataDir;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "spring-mouse-lifecycle-"));
  process.env.DATA_DIR = dataDir;
  db = await import("../../src/lib/db/driver.js");
  mousesRepo = await import("../../src/lib/db/repos/mousesRepo.js");
  connectionsRepo = await import("../../src/lib/db/repos/connectionsRepo.js");
  localDb = await import("../../src/lib/db/index.js");
  await db.getAdapter();
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("mouse node lifecycle", () => {
  it("treats a freshly created node as unregistered until it reports in", async () => {
    const created = await mousesRepo.createMouse({ name: "worker-1" });

    expect(created.token).toMatch(/^mst_/);
    expect(created.mouse.status).toBe("unregistered");
    expect(created.mouse.isOnline).toBe(false);
    expect(created.mouse.lastHeartbeatAt).toBeNull();

    // Opening a tunnel is what registers a node, and the keepalive on that
    // stream is what keeps it online — there is no heartbeat request to send.
    const touched = await mousesRepo.touchMouseHeartbeat(created.mouse.id, { version: "2.0.0" });
    expect(touched.isOnline).toBe(true);
    expect(touched.status).toBe("online");
    expect(touched.version).toBe("2.0.0");
    expect(await mousesRepo.getAvailableMouseById(created.mouse.id)).toBeTruthy();
  });

  it("rejects a name that is missing or too long", async () => {
    expect((await mousesRepo.createMouse({ name: "   " })).validationError).toBeTruthy();
    expect((await mousesRepo.createMouse({ name: "x".repeat(81) })).validationError).toBeTruthy();
  });

  it("rotates the token and retires the previous one", async () => {
    const created = await mousesRepo.createMouse({ name: "rotating" });

    const rotated = await mousesRepo.rotateMouseToken(created.mouse.id);
    expect(rotated.token).toMatch(/^mst_/);
    expect(rotated.token).not.toBe(created.token);
    expect(await mousesRepo.getMouseByAccessToken(created.token)).toBeNull();
    expect((await mousesRepo.getMouseByAccessToken(rotated.token)).id).toBe(created.mouse.id);

    expect(await mousesRepo.rotateMouseToken("does-not-exist")).toBeNull();
  });

  it("disables a node without deleting it", async () => {
    const created = await mousesRepo.createMouse({ name: "disable-me" });
    await mousesRepo.touchMouseHeartbeat(created.mouse.id, {});

    const disabled = await mousesRepo.updateMouse(created.mouse.id, { disabled: true });
    expect(disabled.mouse.status).toBe("disabled");
    expect(disabled.mouse.isOnline).toBe(false);
    expect(await mousesRepo.getAvailableMouseById(created.mouse.id)).toBeNull();

    // Calling off the disable has to restore it: the row was never removed.
    const enabled = await mousesRepo.updateMouse(created.mouse.id, { disabled: false });
    expect(enabled.mouse.disabledAt).toBeNull();
    expect((await mousesRepo.getMouseById(created.mouse.id)).name).toBe("disable-me");
  });

  it("unbinds the accounts that pointed at a deleted node", async () => {
    const created = await mousesRepo.createMouse({ name: "hosts-an-account" });
    const connection = await connectionsRepo.createProviderConnection({
      provider: "test-provider",
      authType: "apikey",
      name: "remote",
      apiKey: "secret",
      mouseId: created.mouse.id,
    });
    expect(connection.mouseId).toBe(created.mouse.id);

    expect(await mousesRepo.deleteMouse(created.mouse.id)).toBe(true);
    // Deleting a node restores its accounts to local execution rather than
    // leaving them bound to something that no longer exists.
    expect((await connectionsRepo.getProviderConnectionById(connection.id)).mouseId).toBeNull();
    expect(await mousesRepo.deleteMouse(created.mouse.id)).toBe(false);
  });

  it("keeps node identities and bindings through export/import", async () => {
    const created = await mousesRepo.createMouse({ name: "exported" });
    await mousesRepo.touchMouseHeartbeat(created.mouse.id, {});
    const listed = await connectionsRepo.getProviderConnections();
    await connectionsRepo.updateProviderConnection(listed[0].id, { mouseId: created.mouse.id });

    const snapshot = await localDb.exportDb();
    // The reverse connection means there is no address on the node to export:
    // the token is the whole identity.
    expect(snapshot.mouses[0]).not.toHaveProperty("callbackUrl");

    const restored = await localDb.importDb(snapshot);
    const restoredMouse = restored.mouses.find((mouse) => mouse.id === created.mouse.id);
    expect(restoredMouse).toBeTruthy();
    expect(restoredMouse.accessTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(restored.providerConnections.some((c) => c.mouseId === created.mouse.id)).toBe(true);
  });

  it("no longer exposes the address-based helpers", () => {
    // Removed with the polling model: Spring has nothing to dial any more.
    for (const name of ["registerMouse", "updateMouseHeartbeat", "rotateMouseExecutionToken", "normalizeCallbackUrl"]) {
      expect(localDb[name]).toBeUndefined();
    }
    expect(typeof localDb.touchMouseHeartbeat).toBe("function");
  });
});
