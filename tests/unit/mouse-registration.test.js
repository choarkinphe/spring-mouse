import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let db;
let mousesRepo;
let connectionsRepo;
let dataDir;
let accessToken;
let registeredMouseId;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "spring-mouse-test-"));
  process.env.DATA_DIR = dataDir;
  db = await import("../../src/lib/db/driver.js");
  mousesRepo = await import("../../src/lib/db/repos/mousesRepo.js");
  connectionsRepo = await import("../../src/lib/db/repos/connectionsRepo.js");
  await db.getAdapter();
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("mouse client identity and access tokens", () => {
  it("registers multiple client ids with one reusable token", async () => {
    const created = await mousesRepo.createMouseAccessToken({ name: "shared token", ttlSeconds: null });
    accessToken = created.token;

    const first = await mousesRepo.registerMouse({
      mouseToken: accessToken,
      clientId: "worker-1",
      name: "worker-1",
      version: "0.1.0",
      capabilities: ["http"],
      metadata: { region: "test" },
      callbackUrl: "http://127.0.0.1:9101/",
    });
    const second = await mousesRepo.registerMouse({
      mouseToken: accessToken,
      clientId: "worker-2",
      name: "worker-2",
      callbackUrl: "http://127.0.0.1:9102/",
    });

    expect(accessToken).toMatch(/^mst_/);
    expect(first.mouse.clientId).toBe("worker-1");
    expect(first.executionToken).toMatch(/^msx_/);
    expect(first.mouse.callbackUrl).toBe("http://127.0.0.1:9101");
    expect(second.mouse.clientId).toBe("worker-2");
    expect(await mousesRepo.getMouseAccessTokens()).toHaveLength(1);

    const updated = await mousesRepo.registerMouse({
      mouseToken: accessToken,
      clientId: "worker-1",
      name: "worker-1 renamed",
      version: "0.1.1",
      callbackUrl: "http://127.0.0.1:9101",
    });
    expect(updated.mouse.id).toBe(first.mouse.id);
    expect(updated.mouse.name).toBe("worker-1 renamed");
    expect(updated.executionToken).not.toBe(first.executionToken);
    registeredMouseId = first.mouse.id;

    const heartbeat = await mousesRepo.updateMouseHeartbeat("worker-1", {
      version: "0.1.2",
      capabilities: ["http", "ws"],
    });
    expect(heartbeat.isOnline).toBe(true);
    expect(heartbeat.version).toBe("0.1.2");
    expect(await mousesRepo.getAvailableMouseById(first.mouse.id)).toBeTruthy();

    const connection = await connectionsRepo.createProviderConnection({
      provider: "test-provider",
      authType: "apikey",
      name: "remote",
      apiKey: "secret",
      mouseId: first.mouse.id,
    });
    expect(connection.mouseId).toBe(first.mouse.id);
    const stored = await connectionsRepo.getProviderConnectionById(connection.id);
    expect(stored.apiKey).toBe("secret");
  });

  it("supports rotation and deletion for a token", async () => {
    const tokens = await mousesRepo.getMouseAccessTokens();
    const rotated = await mousesRepo.rotateMouseAccessToken(tokens[0].id, { ttlSeconds: 3600 });
    expect(await mousesRepo.authenticateMouseAccessToken(accessToken)).toBeNull();
    expect(await mousesRepo.authenticateMouseAccessToken(rotated.token)).toBeTruthy();
    expect(await mousesRepo.registerMouse({
      mouseToken: rotated.token,
      clientId: "worker-3",
      callbackUrl: "http://127.0.0.1:9103",
    })).toBeTruthy();

    expect(await mousesRepo.deleteMouseAccessToken(tokens[0].id)).toBe(true);
    expect(await mousesRepo.authenticateMouseAccessToken(rotated.token)).toBeNull();
    const rejected = await mousesRepo.registerMouse({
      mouseToken: rotated.token,
      clientId: "worker-4",
      callbackUrl: "http://127.0.0.1:9104",
    });
    expect(rejected.error).toBe("invalid_mouse_token");
  });

  it("preserves mouse identities and optional bindings through export/import", async () => {
    const localDb = await import("../../src/lib/db/index.js");
    const listed = await connectionsRepo.getProviderConnections();
    await connectionsRepo.updateProviderConnection(listed[0].id, { mouseId: registeredMouseId });

    const snapshot = await localDb.exportDb();
    const restored = await localDb.importDb(snapshot);
    const restoredMouse = restored.mouses.find((mouse) => mouse.id === registeredMouseId);
    expect(restoredMouse).toBeTruthy();
    expect(restoredMouse.clientId).toBe("worker-1");
    expect(restoredMouse.accessTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(restored.providerConnections[0].mouseId).toBe(registeredMouseId);
    expect(restored.mouseAccessTokens).toHaveLength(0);
  });
});
