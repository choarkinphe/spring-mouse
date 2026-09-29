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
const { normalizeReplicaUrl, buildConfig, buildEnv, SUPPORTED_SCHEMES, getDefaultReplicaUrl, BACKUP_DIR } = await import("../../src/lib/backup/litestreamConfig.js");
const { validateDestination, describeDestination, stripUserInfo } = await import("../../src/shared/constants/backupDestinations.js");

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

describe("default replica destination", () => {
  // The default is what lets "enable backup" be one click with no URL typed.
  it("is a file:// URL under the data dir", () => {
    const url = getDefaultReplicaUrl();
    expect(url.startsWith("file://")).toBe(true);
    expect(url).toContain(tmpDir);
  });

  it("is accepted by normalizeReplicaUrl (no scheme/absolute-path surprise)", () => {
    expect(normalizeReplicaUrl(getDefaultReplicaUrl())).toBe(getDefaultReplicaUrl());
  });

  it("does not collide with litestream's own state directory", () => {
    // BACKUP_DIR holds litestream.yml, the pid file and restore staging; the
    // replica must live elsewhere so a restore never stages beside its source.
    const replicaPath = getDefaultReplicaUrl().replace(/^file:\/\//, "");
    expect(replicaPath).not.toBe(BACKUP_DIR);
    expect(replicaPath.startsWith(BACKUP_DIR + "/")).toBe(false);
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
  it("emits the database path and a typed replica block", () => {
    const yaml = buildConfig(
      { type: "s3", config: { bucket: "mybucket", path: "prefix", region: "us-east-1" } },
      { databasePath: "/data/db/data.sqlite" },
    );
    expect(yaml).toContain('path: "/data/db/data.sqlite"');
    expect(yaml).toContain('type: "s3"');
    expect(yaml).toContain('bucket: "mybucket"');
    expect(yaml).toContain('path: "prefix"');
  });

  it("keeps the legacy url form for a type:\"url\" destination", () => {
    const yaml = buildConfig({ type: "url", config: { url: "s3://bucket/prefix" } });
    expect(yaml).toContain('url: "s3://bucket/prefix"');
    expect(yaml).not.toContain("type:");
  });

  it("never writes a credential VALUE into the config file, for any type", () => {
    // One known secret per type; none of them may appear in the YAML.
    const secrets = {
      s3: { accessKeyId: "AKIDknownvalue", accessKeySecret: "SECRETknownvalue" },
      oss: { accessKeyId: "AKIDknownvalue", accessKeySecret: "SECRETknownvalue" },
      abs: { accountKey: "ABSKEYknownvalue" },
      sftp: { password: "SFTPPASSknownvalue" },
      webdav: { username: "WEBDAVUSERknownvalue", password: "WEBDAVPASSknownvalue" },
      nats: { username: "NATSUSERknownvalue", password: "NATSPASSknownvalue" },
    };
    const configs = {
      s3: { bucket: "b", path: "p" },
      oss: { bucket: "b", path: "p", region: "r" },
      abs: { accountName: "a", bucket: "b", path: "p" },
      sftp: { host: "h:22", user: "u", path: "/p" },
      webdav: { webdavUrl: "https://h/dav", path: "/p" },
      nats: { url: "nats://h:4222/b" },
    };
    for (const type of Object.keys(secrets)) {
      const yaml = buildConfig({ type, config: configs[type], secret: secrets[type] });
      for (const value of Object.values(secrets[type])) {
        expect(yaml).not.toContain(value);
      }
      // Only ${VAR} names may appear, never a bare credential field holding a value.
      expect(yaml).not.toMatch(/(access-key-id|secret-access-key):\s*"(?!\$\{)/);
    }
  });

  it("references sftp/nats/webdav/abs credentials by ${VAR} placeholder", () => {
    expect(buildConfig({ type: "sftp", config: { host: "h", user: "u", path: "/p" }, secret: { password: "x" } }))
      .toContain('password: "${SFTP_PASSWORD}"');
    expect(buildConfig({ type: "webdav", config: { webdavUrl: "https://h/d", path: "/p" }, secret: { username: "u", password: "x" } }))
      .toContain('webdav-username: "${LITESTREAM_WEBDAV_USERNAME}"');
    expect(buildConfig({ type: "abs", config: { accountName: "a", bucket: "b", path: "p" }, secret: { accountKey: "k" } }))
      .toContain('account-key: "${LITESTREAM_AZURE_ACCOUNT_KEY}"');
  });

  it("omits optional empty fields rather than emitting blank keys", () => {
    const yaml = buildConfig({ type: "s3", config: { bucket: "b", path: "", region: "", endpoint: "" } });
    expect(yaml).toContain('bucket: "b"');
    expect(yaml).not.toContain("endpoint:");
    expect(yaml).not.toContain("region:");
  });

  it("emits no credentials for file and gs (they need none)", () => {
    for (const [type, config] of [["file", { path: "/mnt/x" }], ["gs", { bucket: "b", path: "p" }]]) {
      const yaml = buildConfig({ type, config });
      expect(yaml).toContain(`type: "${type}"`);
      expect(yaml).not.toContain("${");
    }
  });

  it("quotes values so a URL containing ':' cannot break the YAML", () => {
    const yaml = buildConfig({ type: "webdav", config: { webdavUrl: "https://user:pass@host/path", path: "/p" } });
    expect(yaml).toContain('webdav-url: "https://user:pass@host/path"');
  });

  it("refuses to build a legacy url destination without a URL", () => {
    expect(() => buildConfig({ type: "url", config: { url: "" } })).toThrow(/required/);
  });

  it("refuses an unknown type", () => {
    expect(() => buildConfig({ type: "nope", config: {} })).toThrow(/Unknown backup destination type/);
  });
});

describe("litestream child environment", () => {
  it("sets the AccessKey pair for s3", () => {
    const env = buildEnv({ type: "s3", config: {}, secret: { accessKeyId: "ID", accessKeySecret: "SECRET" } }, { baseEnv: {} });
    expect(env.LITESTREAM_ACCESS_KEY_ID).toBe("ID");
    expect(env.LITESTREAM_SECRET_ACCESS_KEY).toBe("SECRET");
    expect(env.OSS_ACCESS_KEY_ID).toBeUndefined();
  });

  it("also sets the OSS-specific variables for oss", () => {
    const env = buildEnv({ type: "oss", config: {}, secret: { accessKeyId: "ID", accessKeySecret: "SECRET" } }, { baseEnv: {} });
    expect(env.LITESTREAM_ACCESS_KEY_ID).toBe("ID");
    expect(env.OSS_ACCESS_KEY_ID).toBe("ID");
    expect(env.OSS_ACCESS_KEY_SECRET).toBe("SECRET");
  });

  it("uses SFTP_PASSWORD for sftp (no AccessKey vars)", () => {
    const env = buildEnv({ type: "sftp", config: { host: "h" }, secret: { password: "PW" } }, { baseEnv: {} });
    expect(env.SFTP_PASSWORD).toBe("PW");
    expect(env.LITESTREAM_ACCESS_KEY_ID).toBeUndefined();
    expect(env.LITESTREAM_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it("uses the WebDAV variables for webdav", () => {
    const env = buildEnv({ type: "webdav", config: {}, secret: { username: "U", password: "P" } }, { baseEnv: {} });
    expect(env.LITESTREAM_WEBDAV_USERNAME).toBe("U");
    expect(env.LITESTREAM_WEBDAV_PASSWORD).toBe("P");
  });

  it("uses the Azure account key for abs", () => {
    const env = buildEnv({ type: "abs", config: {}, secret: { accountKey: "K" } }, { baseEnv: {} });
    expect(env.LITESTREAM_AZURE_ACCOUNT_KEY).toBe("K");
  });

  it("uses the NATS variables for nats", () => {
    const env = buildEnv({ type: "nats", config: {}, secret: { username: "U", password: "P" } }, { baseEnv: {} });
    expect(env.NATS_USERNAME).toBe("U");
    expect(env.NATS_PASSWORD).toBe("P");
  });

  it("sets nothing for file and gs", () => {
    for (const type of ["file", "gs"]) {
      const env = buildEnv({ type, config: {}, secret: {} }, { baseEnv: { PATH: "/usr/bin" } });
      expect(env.LITESTREAM_ACCESS_KEY_ID).toBeUndefined();
      expect(env.LITESTREAM_SECRET_ACCESS_KEY).toBeUndefined();
    }
  });

  it("omits empty credentials rather than sending blank auth", () => {
    const env = buildEnv({ type: "sftp", config: {}, secret: {} }, { baseEnv: {} });
    expect(env.SFTP_PASSWORD).toBeUndefined();
  });

  it("preserves the parent environment", () => {
    const env = buildEnv({ type: "s3", config: {}, secret: { accessKeyId: "ID", accessKeySecret: "S" } }, { baseEnv: { PATH: "/usr/bin" } });
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("per-type destination validation", () => {
  it("requires the AccessKey pair for s3", () => {
    const bad = validateDestination({ type: "s3", config: { bucket: "b" }, secret: {} });
    expect(bad.ok).toBe(false);
    expect(bad.errors.accessKeyId).toBeTruthy();
    expect(validateDestination({ type: "s3", config: { bucket: "b" }, secret: { accessKeyId: "i", accessKeySecret: "s" } }).ok).toBe(true);
  });

  it("needs no secret for file and gs", () => {
    expect(validateDestination({ type: "file", config: { path: "/mnt/x" } }).ok).toBe(true);
    expect(validateDestination({ type: "gs", config: { bucket: "b" } }).ok).toBe(true);
  });

  it("accepts sftp with a key path and no password", () => {
    expect(validateDestination({ type: "sftp", config: { host: "h", user: "u", path: "/p", keyPath: "/k" }, secret: {} }).ok).toBe(true);
    // ...but rejects it with neither a password nor a key path.
    const bad = validateDestination({ type: "sftp", config: { host: "h", user: "u", path: "/p" }, secret: {} });
    expect(bad.ok).toBe(false);
    expect(bad.errors.password).toBeTruthy();
  });

  it("flags a missing required config field", () => {
    const bad = validateDestination({ type: "webdav", config: { webdavUrl: "https://h/d" }, secret: { username: "u", password: "p" } });
    expect(bad.ok).toBe(false);
    expect(bad.errors.path).toBeTruthy();
  });

  it("allows a blank secret when editing (requireSecret:false)", () => {
    expect(validateDestination({ type: "s3", config: { bucket: "b" }, secret: {}, requireSecret: false }).ok).toBe(true);
  });
});

describe("destination display address", () => {
  it("never renders a password for sftp", () => {
    const url = describeDestination({ type: "sftp", config: { host: "h:22", user: "u", path: "/p" } });
    expect(url).toBe("sftp://u@h:22/p");
    // No password segment: the only "@" is preceded by the bare username.
    expect(url).toMatch(/^sftp:\/\/u@/);
  });

  it("strips userinfo from a webdav URL", () => {
    expect(stripUserInfo("webdavs://user:secret@host/dav")).toBe("webdavs://host/dav");
    const url = describeDestination({ type: "webdav", config: { webdavUrl: "webdavs://user:secret@host/dav", path: "/p" } });
    expect(url).not.toContain("secret");
  });

  it("strips userinfo from a legacy url destination", () => {
    expect(describeDestination({ type: "url", config: { url: "sftp://user:pw@host/path" } })).not.toContain("pw");
  });

  it("derives bucket-style addresses for object stores", () => {
    expect(describeDestination({ type: "s3", config: { bucket: "b", path: "p" } })).toBe("s3://b/p");
    expect(describeDestination({ type: "gs", config: { bucket: "b", path: "p" } })).toBe("gs://b/p");
  });
});

