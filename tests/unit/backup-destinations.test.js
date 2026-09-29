import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sm-dest-test-"));
process.env.DATA_DIR = tmpDir;
delete process.env.SPRING_MOUSE_BACKUP_KEY;

const {
  resolveBackupSettings, getActiveDestination, getActiveDestinationId,
  destinationHasCredentials, normalizeDestinationInput, newDestinationId, LEGACY_ID,
} = await import("../../src/lib/backup/destinations.js");
const { encryptBackupSecret } = await import("../../src/lib/backup/crypto.js");

afterEach(() => {
  delete process.env.SPRING_MOUSE_BACKUP_KEY;
});

describe("resolveBackupSettings", () => {
  it("returns the stored list when present", () => {
    const settings = {
      backupDestinations: [{ id: "d1", type: "file", config: { path: "/mnt/x" }, secretEncrypted: null }],
      backupActiveDestinationId: "d1",
    };
    const { destinations, legacy } = resolveBackupSettings(settings);
    expect(destinations).toHaveLength(1);
    expect(legacy).toBe(false);
  });

  it("synthesizes one type:\"url\" destination from the legacy columns", () => {
    const { destinations, legacy } = resolveBackupSettings({
      backupReplicaUrl: "s3://bucket/prefix",
      backupAccessKeyIdEncrypted: null,
    });
    expect(legacy).toBe(true);
    expect(destinations).toHaveLength(1);
    expect(destinations[0].type).toBe("url");
    expect(destinations[0].config.url).toBe("s3://bucket/prefix");
    expect(destinations[0].id).toBe(LEGACY_ID);
  });

  it("returns an empty list when nothing is configured", () => {
    expect(resolveBackupSettings({ backupReplicaUrl: "" }).destinations).toHaveLength(0);
    expect(resolveBackupSettings({}).destinations).toHaveLength(0);
  });
});

describe("active destination selection", () => {
  const list = [
    { id: "d1", type: "file", config: { path: "/a" }, secretEncrypted: null },
    { id: "d2", type: "file", config: { path: "/b" }, secretEncrypted: null },
  ];

  it("honors the stored active id", () => {
    expect(getActiveDestinationId({ backupDestinations: list, backupActiveDestinationId: "d2" }, list)).toBe("d2");
  });

  it("falls back to the first destination when the stored id is stale", () => {
    expect(getActiveDestinationId({ backupDestinations: list, backupActiveDestinationId: "gone" }, list)).toBe("d1");
  });

  it("returns the active destination object", () => {
    const { destination } = getActiveDestination({ backupDestinations: list, backupActiveDestinationId: "d2" });
    expect(destination.config.path).toBe("/b");
  });

  it("returns null when there are no destinations", () => {
    expect(getActiveDestination({ backupDestinations: [] }).destination).toBeNull();
  });
});

describe("destinationHasCredentials", () => {
  it("is true for file and gs (they need none)", () => {
    expect(destinationHasCredentials({ type: "file", config: {} })).toBe(true);
    expect(destinationHasCredentials({ type: "gs", config: {} })).toBe(true);
  });

  it("is true for sftp with a key path but no secret blob", () => {
    expect(destinationHasCredentials({ type: "sftp", config: { keyPath: "/k" }, secretEncrypted: null })).toBe(true);
  });

  it("is false when a required secret blob is missing", () => {
    expect(destinationHasCredentials({ type: "s3", config: {}, secretEncrypted: null })).toBe(false);
  });

  it("is true when the secret blob decrypts", () => {
    const blob = encryptBackupSecret(JSON.stringify({ accessKeyId: "i", accessKeySecret: "s" }));
    expect(destinationHasCredentials({ type: "s3", config: {}, secretEncrypted: blob })).toBe(true);
  });

  it("is false when the secret blob cannot be decrypted (key lost)", () => {
    const blob = encryptBackupSecret(JSON.stringify({ accessKeyId: "i" }));
    // A different key makes the ciphertext undecryptable, mirroring a lost key file.
    process.env.SPRING_MOUSE_BACKUP_KEY = Buffer.alloc(32, 9).toString("base64");
    expect(destinationHasCredentials({ type: "s3", config: {}, secretEncrypted: blob })).toBe(false);
  });
});

describe("normalizeDestinationInput", () => {
  it("trims config and drops empty optional fields", () => {
    const out = normalizeDestinationInput({
      type: "s3",
      label: "  My Bucket  ",
      config: { bucket: " b ", path: "  ", region: "" },
      secret: { accessKeyId: " id ", accessKeySecret: " sec " },
    });
    expect(out.label).toBe("My Bucket");
    expect(out.config).toEqual({ bucket: "b", path: "", region: "", endpoint: "", forcePathStyle: false });
    // Secrets are kept verbatim — trimming a password would corrupt it.
    expect(out.secret).toEqual({ accessKeyId: " id ", accessKeySecret: " sec " });
  });

  it("treats a whitespace-only secret as not provided", () => {
    const out = normalizeDestinationInput(
      { type: "s3", config: { bucket: "b" }, secret: { accessKeyId: "   ", accessKeySecret: "  " } },
      { requireSecret: false },
    );
    expect(out.secret).toEqual({});
  });

  it("throws on an unknown type", () => {
    expect(() => normalizeDestinationInput({ type: "nope" })).toThrow(/Unknown backup destination type/);
  });

  it("throws on a missing required field", () => {
    expect(() => normalizeDestinationInput({ type: "s3", config: {}, secret: { accessKeyId: "i", accessKeySecret: "s" } }))
      .toThrow(/Bucket/);
  });

  it("throws when a required secret is missing", () => {
    expect(() => normalizeDestinationInput({ type: "s3", config: { bucket: "b" }, secret: {} }))
      .toThrow(/AccessKey/);
  });

  it("accepts a blank secret when editing", () => {
    const out = normalizeDestinationInput({ type: "s3", config: { bucket: "b" }, secret: {} }, { requireSecret: false });
    expect(out.secret).toEqual({});
  });
});

describe("newDestinationId", () => {
  it("produces a prefixed, unique id", () => {
    const a = newDestinationId();
    const b = newDestinationId();
    expect(a).toMatch(/^dst_[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });
});
