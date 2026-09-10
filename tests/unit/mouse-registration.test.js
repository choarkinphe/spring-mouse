import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let db;
let mousesRepo;
let connectionsRepo;
let dataDir;
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

describe("mouse registration and optional channel binding", () => {
  it("registers a one-time token, authenticates heartbeats, and binds/unbinds a connection", async () => {
    const created = await mousesRepo.createMouseRegistrationToken({ name: "test mouse" });
    const registered = await mousesRepo.registerMouse({
      registrationToken: created.token,
      name: "worker-1",
      version: "0.1.0",
      capabilities: ["http"],
      metadata: { region: "test" },
    });

    expect(registered.mouse.name).toBe("worker-1");
    expect(registered.accessToken).toMatch(/^mse_/);
    registeredMouseId = registered.mouse.id;
    const replay = await mousesRepo.registerMouse({ registrationToken: created.token });
    expect(replay.error).toBe("invalid_registration_token");

    const authenticated = await mousesRepo.authenticateMouseAccessToken(registered.accessToken);
    expect(authenticated.id).toBe(registered.mouse.id);

    const heartbeat = await mousesRepo.updateMouseHeartbeat(authenticated.id, {
      version: "0.1.1",
      capabilities: ["http", "ws"],
    });
    expect(heartbeat.isOnline).toBe(true);
    expect(heartbeat.version).toBe("0.1.1");

    const connection = await connectionsRepo.createProviderConnection({
      provider: "test-provider",
      authType: "apikey",
      name: "remote",
      apiKey: "secret",
      mouseId: registered.mouse.id,
    });
    expect(connection.mouseId).toBe(registered.mouse.id);
    expect(await mousesRepo.getAvailableMouseById(registered.mouse.id)).toBeTruthy();

    const stored = await connectionsRepo.getProviderConnectionById(connection.id);
    expect(stored.apiKey).toBe("secret");

    const unbound = await connectionsRepo.updateProviderConnection(connection.id, { mouseId: null });
    expect(unbound.mouseId).toBeNull();
  });

  it("preserves mouse identities and optional bindings through export/import", async () => {
    const localDb = await import("../../src/lib/db/index.js");
    const listed = await connectionsRepo.getProviderConnections();
    await connectionsRepo.updateProviderConnection(listed[0].id, { mouseId: registeredMouseId });

    const snapshot = await localDb.exportDb();
    const restored = await localDb.importDb(snapshot);
    const restoredMouse = restored.mouses.find((mouse) => mouse.id === registeredMouseId);
    expect(restoredMouse).toBeTruthy();
    expect(restoredMouse.accessTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(restored.providerConnections[0].mouseId).toBe(registeredMouseId);
  });
});
