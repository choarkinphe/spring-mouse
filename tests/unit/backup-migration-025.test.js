import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The crypto key resolves under DATA_DIR at import time, so set it first.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sm-mig025-test-"));
process.env.DATA_DIR = tmpDir;
delete process.env.SPRING_MOUSE_BACKUP_KEY;

const migration = (await import("../../src/lib/db/migrations/025-backup-destinations.js")).default;
const { encryptBackupSecret, decryptBackupSecret } = await import("../../src/lib/backup/crypto.js");

// A minimal adapter that records what the migration wrote.
function makeDb(initial) {
  let data = JSON.stringify(initial);
  return {
    get: () => ({ data }),
    run: (_sql, params) => { data = params[0]; },
    read: () => JSON.parse(data),
  };
}

afterEach(() => {
  delete process.env.SPRING_MOUSE_BACKUP_KEY;
});

describe("migration 025: backup destinations", () => {
  it("converts a legacy URL + AccessKey pair into one type:\"url\" destination", () => {
    const db = makeDb({
      backupEnabled: true,
      backupReplicaUrl: "s3://bucket/prefix",
      backupAccessKeyIdEncrypted: encryptBackupSecret("AKID-1"),
      backupAccessKeySecretEncrypted: encryptBackupSecret("SECRET-1"),
      someOtherSetting: 42,
    });

    migration.up(db);
    const after = db.read();

    expect(after.backupDestinations).toHaveLength(1);
    const dest = after.backupDestinations[0];
    expect(dest.type).toBe("url");
    expect(dest.config.url).toBe("s3://bucket/prefix");
    expect(after.backupActiveDestinationId).toBe(dest.id);

    // The credentials survive, re-encrypted into the destination's own blob.
    const secret = JSON.parse(decryptBackupSecret(dest.secretEncrypted));
    expect(secret).toEqual({ accessKeyId: "AKID-1", accessKeySecret: "SECRET-1" });

    // The legacy keys are gone, and unrelated settings are untouched.
    expect(after.backupReplicaUrl).toBeUndefined();
    expect(after.backupAccessKeyIdEncrypted).toBeUndefined();
    expect(after.backupAccessKeySecretEncrypted).toBeUndefined();
    expect(after.someOtherSetting).toBe(42);
  });

  it("migrates a URL with no credentials", () => {
    const db = makeDb({ backupReplicaUrl: "file:///mnt/backup", backupEnabled: true });
    migration.up(db);
    const after = db.read();
    expect(after.backupDestinations).toHaveLength(1);
    expect(after.backupDestinations[0].secretEncrypted).toBeNull();
  });

  it("is a no-op when the list is already present", () => {
    const existing = [{ id: "d1", type: "file", config: { path: "/x" }, secretEncrypted: null }];
    const db = makeDb({ backupDestinations: existing, backupActiveDestinationId: "d1", backupReplicaUrl: "s3://old" });
    migration.up(db);
    const after = db.read();
    expect(after.backupDestinations).toEqual(existing);
    // The stale legacy URL is left alone: a present list means "already migrated".
    expect(after.backupReplicaUrl).toBe("s3://old");
  });

  it("is a no-op when there is no legacy URL", () => {
    const db = makeDb({ backupEnabled: false, backupReplicaUrl: "" });
    migration.up(db);
    expect(db.read().backupDestinations).toBeUndefined();
  });

  it("leaves the row intact when the credentials cannot be decrypted", () => {
    // Encrypt with one key, then swap the key so decryption fails — the same
    // situation as a lost key file. The row must survive so the runtime
    // fallback can still resolve the legacy columns.
    const idEncrypted = encryptBackupSecret("AKID-1");
    process.env.SPRING_MOUSE_BACKUP_KEY = Buffer.alloc(32, 3).toString("base64");

    const db = makeDb({
      backupReplicaUrl: "s3://bucket/prefix",
      backupAccessKeyIdEncrypted: idEncrypted,
      backupAccessKeySecretEncrypted: idEncrypted,
    });
    migration.up(db);
    const after = db.read();
    expect(after.backupDestinations).toBeUndefined();
    expect(after.backupReplicaUrl).toBe("s3://bucket/prefix");
    expect(after.backupAccessKeyIdEncrypted).toBe(idEncrypted);
  });

  it("preserves a malformed settings row rather than throwing", () => {
    let data = "{not json";
    const db = { get: () => ({ data }), run: (_s, p) => { data = p[0]; } };
    expect(() => migration.up(db)).not.toThrow();
    expect(data).toBe("{not json");
  });
});
