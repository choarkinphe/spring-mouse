import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The crypto module resolves its key file under DATA_DIR at import time, so the
// temp dir has to be in place before the import. Same approach as the other
// DB-backed unit tests.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sm-backup-test-"));
process.env.DATA_DIR = tmpDir;
delete process.env.SPRING_MOUSE_BACKUP_KEY;

const { encryptBackupSecret, decryptBackupSecret, canDecryptBackupSecret } = await import("../../src/lib/backup/crypto.js");
const { normalizeReplicaUrl, buildConfig, buildEnv, SUPPORTED_SCHEMES } = await import("../../src/lib/backup/litestreamConfig.js");

afterEach(() => {
  delete process.env.SPRING_MOUSE_BACKUP_KEY;
});

describe("backup secret encryption", () => {
  it("round-trips a credential", () => {
    const ciphertext = encryptBackupSecret("AKID-example-secret");
    expect(ciphertext).toMatch(/^v1\./);
    expect(ciphertext).not.toContain("AKID-example-secret");
    expect(decryptBackupSecret(ciphertext)).toBe("AKID-example-secret");
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const a = encryptBackupSecret("same-value");
    const b = encryptBackupSecret("same-value");
    expect(a).not.toBe(b);
    expect(decryptBackupSecret(a)).toBe(decryptBackupSecret(b));
  });

  it("returns null for an empty secret so an untouched form field erases nothing", () => {
    expect(encryptBackupSecret("")).toBeNull();
    expect(encryptBackupSecret(null)).toBeNull();
  });

  it("rejects a tampered ciphertext rather than returning garbage", () => {
    const ciphertext = encryptBackupSecret("original");
    const parts = ciphertext.split(".");
    // Flip a character in the payload; GCM's auth tag must catch it.
    parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith("AA") ? "BB" : "AA");
    expect(() => decryptBackupSecret(parts.join("."))).toThrow();
  });

  it("rejects a malformed payload", () => {
    expect(() => decryptBackupSecret("not-a-payload")).toThrow(/Invalid encrypted backup secret/);
    expect(() => decryptBackupSecret("v2.a.b.c")).toThrow(/Invalid encrypted backup secret/);
  });

  it("canDecryptBackupSecret reports false for null without throwing", () => {
    expect(canDecryptBackupSecret(null)).toBe(false);
    expect(canDecryptBackupSecret(undefined)).toBe(false);
    expect(canDecryptBackupSecret(encryptBackupSecret("x"))).toBe(true);
  });

  it("fails to decrypt with a different key", () => {
    const ciphertext = encryptBackupSecret("value");
    process.env.SPRING_MOUSE_BACKUP_KEY = Buffer.alloc(32, 7).toString("base64");
    expect(canDecryptBackupSecret(ciphertext)).toBe(false);
  });
});

describe("replica URL validation", () => {
  it("accepts every documented scheme", () => {
    const urls = [
      "oss://mybucket.oss-cn-hangzhou.aliyuncs.com/db",
      "s3://bucket/path",
      "gs://bucket/path",
      "sftp://user@host/path",
      "webdavs://user:pass@host/path",
      "file:///mnt/backup/spring-mouse",
    ];
    for (const url of urls) expect(normalizeReplicaUrl(url)).toBe(url);
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeReplicaUrl("  s3://bucket/x  ")).toBe("s3://bucket/x");
  });

  it("returns empty string for empty input (means 'not configured')", () => {
    expect(normalizeReplicaUrl("")).toBe("");
    expect(normalizeReplicaUrl(null)).toBe("");
    expect(normalizeReplicaUrl(undefined)).toBe("");
  });

  it("rejects an unknown scheme instead of silently accepting a typo", () => {
    expect(() => normalizeReplicaUrl("os://bucket/x")).toThrow(/must start with one of/);
    expect(() => normalizeReplicaUrl("/mnt/backup")).toThrow(/must start with one of/);
    expect(() => normalizeReplicaUrl("http://example.com/x")).toThrow(/must start with one of/);
  });

  it("requires an absolute path for file://", () => {
    expect(() => normalizeReplicaUrl("file://relative/path")).toThrow(/absolute/);
  });

  it("advertises the supported schemes for the error message", () => {
    expect(SUPPORTED_SCHEMES).toContain("oss");
    expect(SUPPORTED_SCHEMES).toContain("s3");
    expect(SUPPORTED_SCHEMES).toContain("file");
  });
});

describe("litestream config generation", () => {
  it("emits the database path and replica URL", () => {
    const yaml = buildConfig({ replicaUrl: "s3://bucket/prefix", databasePath: "/data/db/data.sqlite" });
    expect(yaml).toContain('path: "/data/db/data.sqlite"');
    expect(yaml).toContain('url: "s3://bucket/prefix"');
  });

  it("never writes credentials into the config file", () => {
    const yaml = buildConfig({ replicaUrl: "oss://bucket/x", databasePath: "/data/db/data.sqlite" });
    expect(yaml).not.toMatch(/access-key|secret|AKID/i);
  });

  it("quotes values so a URL containing ':' cannot break the YAML", () => {
    const yaml = buildConfig({ replicaUrl: "webdavs://user:pass@host/path", databasePath: "/data/db/data.sqlite" });
    expect(yaml).toContain('url: "webdavs://user:pass@host/path"');
  });

  it("refuses to build without a URL", () => {
    expect(() => buildConfig({ replicaUrl: "" })).toThrow(/required/);
  });
});

describe("litestream child environment", () => {
  it("sets the generic litestream credential variables", () => {
    const env = buildEnv({ accessKeyId: "ID", accessKeySecret: "SECRET", replicaUrl: "s3://bucket/x", baseEnv: {} });
    expect(env.LITESTREAM_ACCESS_KEY_ID).toBe("ID");
    expect(env.LITESTREAM_SECRET_ACCESS_KEY).toBe("SECRET");
  });

  it("also sets the OSS-specific variables for an oss:// replica", () => {
    const env = buildEnv({ accessKeyId: "ID", accessKeySecret: "SECRET", replicaUrl: "oss://bucket/x", baseEnv: {} });
    expect(env.OSS_ACCESS_KEY_ID).toBe("ID");
    expect(env.OSS_ACCESS_KEY_SECRET).toBe("SECRET");
  });

  it("does not set OSS variables for a non-OSS replica", () => {
    const env = buildEnv({ accessKeyId: "ID", accessKeySecret: "SECRET", replicaUrl: "s3://bucket/x", baseEnv: {} });
    expect(env.OSS_ACCESS_KEY_ID).toBeUndefined();
  });

  it("omits empty credentials rather than sending blank auth headers", () => {
    const env = buildEnv({ accessKeyId: "", accessKeySecret: "", replicaUrl: "file:///mnt/x", baseEnv: {} });
    expect(env.LITESTREAM_ACCESS_KEY_ID).toBeUndefined();
    expect(env.LITESTREAM_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it("preserves the parent environment", () => {
    const env = buildEnv({ accessKeyId: "ID", accessKeySecret: "S", replicaUrl: "s3://b/x", baseEnv: { PATH: "/usr/bin" } });
    expect(env.PATH).toBe("/usr/bin");
  });
});
