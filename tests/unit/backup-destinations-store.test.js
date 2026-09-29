import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sm-deststore-test-"));
process.env.DATA_DIR = tmpDir;
delete process.env.SPRING_MOUSE_BACKUP_KEY;

// Control the persisted row and the "engine" so the store's ORDER and VALIDATION
// can be asserted without a real litestream binary or database.
const state = { settings: {} };
const mocks = {
  applyBackupSettings: vi.fn(async () => ({ running: true })),
};

vi.mock("@/lib/backup/supervisor.js", () => ({
  applyBackupSettings: (...args) => mocks.applyBackupSettings(...args),
}));
vi.mock("@/lib/db/repos/settingsRepo.js", () => ({
  getSettings: async () => ({ ...state.settings }),
  updateSettings: async (patch) => {
    state.settings = { ...state.settings, ...patch };
    return { ...state.settings };
  },
}));

const {
  listPublicDestinations, getDestinationsView, createDestination,
  editDestination, deleteDestination, activateDestination, setBackupEnabled,
  DestinationNotFoundError, destinationErrorStatus,
} = await import("../../src/lib/backup/destinationsStore.js");
const { decryptBackupSecret } = await import("../../src/lib/backup/crypto.js");

beforeEach(() => {
  state.settings = { backupEnabled: false, backupDestinations: [], backupActiveDestinationId: null };
  mocks.applyBackupSettings.mockClear();
  mocks.applyBackupSettings.mockImplementation(async () => ({ running: true }));
});

afterEach(() => {
  delete process.env.SPRING_MOUSE_BACKUP_KEY;
});

describe("createDestination", () => {
  it("stores an encrypted secret blob and activates the first destination", async () => {
    const { destinationId } = await createDestination({
      type: "s3",
      label: "主备份",
      config: { bucket: "b", path: "prod", region: "us-east-1" },
      secret: { accessKeyId: "AKID", accessKeySecret: "S3CRET" },
    });

    const stored = state.settings.backupDestinations;
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(destinationId);
    expect(stored[0].label).toBe("主备份");
    // The raw secret is not in the row — only the ciphertext.
    expect(JSON.stringify(state.settings)).not.toContain("S3CRET");
    expect(JSON.parse(decryptBackupSecret(stored[0].secretEncrypted))).toEqual({
      accessKeyId: "AKID", accessKeySecret: "S3CRET",
    });
    expect(state.settings.backupActiveDestinationId).toBe(destinationId);
    expect(mocks.applyBackupSettings).toHaveBeenCalledTimes(1);
  });

  it("does not persist when the engine rejects the new destination", async () => {
    mocks.applyBackupSettings.mockRejectedValueOnce(new Error("litestream failed to start"));
    await expect(createDestination({
      type: "s3", config: { bucket: "b" }, secret: { accessKeyId: "i", accessKeySecret: "s" },
    })).rejects.toThrow(/litestream failed to start/);
    // The engine was tried first, so a failed destination never becomes state.
    expect(state.settings.backupDestinations).toHaveLength(0);
  });

  it("rejects an unknown type", async () => {
    await expect(createDestination({ type: "nope", config: {} })).rejects.toThrow(/Unknown backup destination type/);
    expect(state.settings.backupDestinations).toHaveLength(0);
  });

  it("refuses to create the migration-only url type", async () => {
    await expect(createDestination({ type: "url", config: { url: "s3://x" } }))
      .rejects.toThrow(/Unknown backup destination type: url/);
  });

  it("rejects a missing required credential", async () => {
    await expect(createDestination({ type: "s3", config: { bucket: "b" }, secret: {} }))
      .rejects.toThrow(/AccessKey/);
  });
});

describe("editDestination", () => {
  async function seedS3() {
    const { destinationId } = await createDestination({
      type: "s3", config: { bucket: "b" }, secret: { accessKeyId: "AKID", accessKeySecret: "S3CRET" },
    });
    mocks.applyBackupSettings.mockClear();
    return destinationId;
  }

  it("keeps the stored secret when the secret fields are blank", async () => {
    const id = await seedS3();
    await editDestination(id, { label: "改名", config: { bucket: "b2" }, secret: {} });
    const dest = state.settings.backupDestinations[0];
    expect(dest.label).toBe("改名");
    expect(dest.config.bucket).toBe("b2");
    expect(JSON.parse(decryptBackupSecret(dest.secretEncrypted))).toEqual({
      accessKeyId: "AKID", accessKeySecret: "S3CRET",
    });
  });

  it("merges a partial secret over the stored one", async () => {
    const id = await seedS3();
    // Only the secret rotates; the id is left blank and must be preserved.
    await editDestination(id, { config: { bucket: "b" }, secret: { accessKeySecret: "NEWSECRET" } });
    const dest = state.settings.backupDestinations[0];
    expect(JSON.parse(decryptBackupSecret(dest.secretEncrypted))).toEqual({
      accessKeyId: "AKID", accessKeySecret: "NEWSECRET",
    });
  });

  it("throws a not-found error for an unknown id", async () => {
    await expect(editDestination("dst_missing", { label: "x" })).rejects.toBeInstanceOf(DestinationNotFoundError);
  });

  it("rejects an edit that would leave a required field empty", async () => {
    const id = await seedS3();
    await expect(editDestination(id, { config: { bucket: "" } })).rejects.toThrow(/Bucket/);
  });
});

describe("deleteDestination", () => {
  it("hands over to the next destination and keeps backup on", async () => {
    const a = (await createDestination({ type: "file", config: { path: "/a" } })).destinationId;
    const b = (await createDestination({ type: "file", config: { path: "/b" } })).destinationId;
    await activateDestination(a);

    await deleteDestination(a);
    expect(state.settings.backupDestinations.map((d) => d.id)).toEqual([b]);
    expect(state.settings.backupActiveDestinationId).toBe(b);
    expect(state.settings.backupEnabled).toBe(false); // was never turned on in this fixture
  });

  it("turns backup off when the last destination is removed", async () => {
    state.settings.backupEnabled = true;
    const id = (await createDestination({ type: "file", config: { path: "/only" } })).destinationId;
    await deleteDestination(id);
    expect(state.settings.backupDestinations).toHaveLength(0);
    expect(state.settings.backupActiveDestinationId).toBeNull();
    expect(state.settings.backupEnabled).toBe(false);
  });

  it("throws a not-found error for an unknown id", async () => {
    await expect(deleteDestination("dst_missing")).rejects.toBeInstanceOf(DestinationNotFoundError);
  });
});

describe("activateDestination", () => {
  it("switches the active pointer and materializes the list", async () => {
    const a = (await createDestination({ type: "file", config: { path: "/a" } })).destinationId;
    const b = (await createDestination({ type: "file", config: { path: "/b" } })).destinationId;
    await activateDestination(b);
    expect(state.settings.backupActiveDestinationId).toBe(b);
    expect(state.settings.backupDestinations.map((d) => d.id)).toEqual([a, b]);
    expect(mocks.applyBackupSettings).toHaveBeenCalled();
  });
});

describe("legacy fallback materialization", () => {
  it("materializes a legacy URL entry on the first mutation", async () => {
    state.settings = {
      backupEnabled: true,
      backupReplicaUrl: "file:///tmp/sm-legacy",
      backupAccessKeyIdEncrypted: null,
      backupAccessKeySecretEncrypted: null,
    };
    // No stored list yet — a fresh install that predates migration 025.
    const id = (await createDestination({ type: "file", config: { path: "/new" } })).destinationId;

    const stored = state.settings.backupDestinations;
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({ id: "dst_legacy", type: "url", config: { url: "file:///tmp/sm-legacy" } });
    // The first entry was active before, so it stays active — adding a
    // destination must not silently switch replication.
    expect(state.settings.backupActiveDestinationId).toBe("dst_legacy");
    expect(stored[1].id).toBe(id);
  });

  it("does not resurrect a deleted legacy entry from the old URL column", async () => {
    state.settings = {
      backupEnabled: true,
      backupReplicaUrl: "file:///tmp/sm-legacy",
      backupAccessKeyIdEncrypted: null,
      backupAccessKeySecretEncrypted: null,
    };
    // The operator removes the migrated entry. The legacy URL column is cleared
    // in the same write, so the read fallback cannot synthesize it again.
    await deleteDestination("dst_legacy");
    expect(state.settings.backupReplicaUrl).toBe("");
    expect(state.settings.backupDestinations).toHaveLength(0);
    expect(listPublicDestinations(state.settings)).toHaveLength(0);
  });

  it("keeps a legacy entry's secret readable from the old columns", async () => {
    const { encryptBackupSecret } = await import("../../src/lib/backup/crypto.js");
    state.settings = {
      backupEnabled: true,
      backupReplicaUrl: "s3://legacy-bucket/p",
      backupAccessKeyIdEncrypted: encryptBackupSecret("AKID-LEGACY"),
      backupAccessKeySecretEncrypted: encryptBackupSecret("SECRET-LEGACY"),
    };
    // Activating materializes the list. The legacy entry has no secretEncrypted
    // of its own — its secret IS the old columns — so those must survive while
    // the entry is in the list, and hasCredentials must read from them.
    await activateDestination("dst_legacy");
    const entry = state.settings.backupDestinations[0];
    expect(entry.id).toBe("dst_legacy");
    expect(entry.secretEncrypted).toBeNull();
    expect(state.settings.backupAccessKeyIdEncrypted).toBeTruthy();
    expect(listPublicDestinations(state.settings)[0].hasCredentials).toBe(true);
  });
});

describe("listPublicDestinations", () => {
  it("returns the display URL and never the secret", async () => {
    await createDestination({
      type: "sftp", label: "SFTP",
      config: { host: "h:22", user: "u", path: "/p" },
      secret: { password: "SSHPASS" },
    });
    const list = listPublicDestinations(state.settings);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ type: "sftp", displayUrl: "sftp://u@h:22/p", hasCredentials: true, isActive: true });
    expect(JSON.stringify(list)).not.toContain("SSHPASS");
    expect(list[0].secretEncrypted).toBeUndefined();
  });

  it("reports hasCredentials for a legacy entry from the old columns", () => {
    state.settings = {
      backupReplicaUrl: "s3://b/p",
      backupAccessKeyIdEncrypted: null,
      backupAccessKeySecretEncrypted: null,
    };
    const list = listPublicDestinations(state.settings);
    expect(list[0]).toMatchObject({ id: "dst_legacy", type: "url", hasCredentials: false });
  });
});

describe("destinationErrorStatus", () => {
  it("maps not-found to 404 and everything else to 400", () => {
    expect(destinationErrorStatus(new DestinationNotFoundError())).toBe(404);
    expect(destinationErrorStatus(new Error("bad config"))).toBe(400);
  });
});

describe("legacy url destination is read-only", () => {
  beforeEach(() => {
    state.settings = {
      backupEnabled: true,
      backupReplicaUrl: "s3://legacy-bucket/prefix",
      backupAccessKeyIdEncrypted: null,
      backupAccessKeySecretEncrypted: null,
    };
  });

  it("refuses to edit the migrated url entry", async () => {
    await expect(editDestination("dst_legacy", { label: "x" }))
      .rejects.toThrow(/旧版 URL 保存位置不可编辑/);
    // Nothing was written.
    expect(state.settings.backupDestinations).toBeUndefined();
  });

  it("still allows deleting it", async () => {
    // Deleting is the migration path: add a typed destination, then remove this.
    await deleteDestination("dst_legacy");
    expect(state.settings.backupDestinations).toHaveLength(0);
    expect(state.settings.backupActiveDestinationId).toBeNull();
    expect(state.settings.backupEnabled).toBe(false);
  });
});

describe("setBackupEnabled", () => {
  it("seeds a local destination when enabling with none configured", async () => {
    await setBackupEnabled(true);
    const stored = state.settings.backupDestinations;
    expect(stored).toHaveLength(1);
    expect(stored[0].type).toBe("file");
    expect(stored[0].config.path).toMatch(/backup$/);
    expect(state.settings.backupEnabled).toBe(true);
    expect(state.settings.backupActiveDestinationId).toBe(stored[0].id);
  });

  it("keeps the existing destination when enabling", async () => {
    const id = (await createDestination({ type: "file", config: { path: "/keep" } })).destinationId;
    state.settings.backupEnabled = false;
    await setBackupEnabled(true);
    expect(state.settings.backupDestinations.map((d) => d.id)).toEqual([id]);
    expect(state.settings.backupActiveDestinationId).toBe(id);
  });

  it("persists NOTHING when the engine fails to start (the ordering fix)", async () => {
    const id = (await createDestination({ type: "file", config: { path: "/x" } })).destinationId;
    state.settings.backupEnabled = false;
    mocks.applyBackupSettings.mockRejectedValueOnce(new Error("cannot run litestream"));

    await expect(setBackupEnabled(true)).rejects.toThrow(/cannot run litestream/);
    // The old settings PATCH left `backupEnabled: true` behind on a failed start;
    // this path must not.
    expect(state.settings.backupEnabled).toBe(false);
    expect(state.settings.backupDestinations.map((d) => d.id)).toEqual([id]);
  });

  it("stops the engine and clears the flag when disabling", async () => {
    state.settings = { backupEnabled: true, backupDestinations: [{ id: "d1", type: "file", config: { path: "/a" } }], backupActiveDestinationId: "d1" };
    await setBackupEnabled(false);
    expect(state.settings.backupEnabled).toBe(false);
    expect(mocks.applyBackupSettings).toHaveBeenCalledWith(expect.objectContaining({ backupEnabled: false }));
  });
});
