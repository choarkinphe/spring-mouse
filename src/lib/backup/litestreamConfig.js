// Builds the litestream YAML config and the child-process environment.
//
// DESIGN: credentials are passed as ENVIRONMENT VARIABLES, never written into
// the YAML. The config file then contains only the database path and the
// replica URL, so it can sit on disk without being a secret, and a stray copy
// of it leaks nothing. (Litestream reads LITESTREAM_ACCESS_KEY_ID /
// LITESTREAM_SECRET_ACCESS_KEY natively; OSS_* is set too because the OSS
// backend documents those names.)
//
// The replica `url` is the whole point of this module: litestream accepts
// s3://, oss://, gs://, sftp://, webdavs://, abs://, file:// — so "where do
// backups go" is one string the operator types, not a code change.

import { DB_DIR, DATA_FILE } from "@/lib/db/paths.js";
import { DATA_DIR } from "@/lib/dataDir.js";
import path from "node:path";

export const BACKUP_DIR = path.join(DB_DIR, "backup");
export const CONFIG_FILE = path.join(BACKUP_DIR, "litestream.yml");

// Where continuous replication goes when the operator has not named a
// destination. Defaulting to a local path is what makes "enable backup" a
// single click instead of a form to fill in — the common case is protecting
// against an accidental delete or a botched migration, which a local copy
// already covers.
//
// ⚠️ Deliberately NOT under BACKUP_DIR: that directory holds litestream's own
// config, pid file and restore staging, and a replica written beside them would
// make a restore's "staged file" and its source share a directory. It sits
// under DATA_DIR instead, so a bind-mounted data volume carries it too.
export function getDefaultReplicaUrl() {
  return `file://${path.join(DATA_DIR, "backup")}`;
}

// A backup URL must be absolute and carry a scheme litestream understands.
// Rejecting unknown schemes here is what keeps a typo ("os://") from silently
// becoming "backup is enabled but nothing is being copied".
const KNOWN_SCHEMES = ["s3:", "oss:", "gs:", "abs:", "sftp:", "webdav:", "webdavs:", "file:", "nats:"];
export const SUPPORTED_SCHEMES = KNOWN_SCHEMES.map((s) => s.replace(":", ""));

export function normalizeReplicaUrl(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  const scheme = KNOWN_SCHEMES.find((s) => value.toLowerCase().startsWith(s));
  if (!scheme) {
    throw new Error(`Backup URL must start with one of: ${SUPPORTED_SCHEMES.join(", ")}`);
  }
  // file:// needs an absolute path; a relative one would resolve against the
  // process CWD and quietly write somewhere unexpected.
  if (scheme === "file:" && !/^file:\/\/\//.test(value)) {
    throw new Error("file:// backup URL must be absolute, e.g. file:///mnt/backup/spring-mouse");
  }
  return value;
}

// Minimal YAML emitter for the one shape litestream needs. Values are quoted
// defensively because a URL may contain ':' and '/' which YAML would otherwise
// reinterpret.
function quote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Which litestream replica fields each type accepts, and their YAML names. The
// config uses the FIELD form (not the `url:` shorthand) because several types
// have parameters a URL cannot express — sftp key-path/host-key, s3 endpoint
// and force-path-style, abs account-name — and those live only here.
const REPLICA_FIELDS = {
  file: [["path", "path"]],
  s3: [["bucket", "bucket"], ["path", "path"], ["region", "region"], ["endpoint", "endpoint"], ["forcePathStyle", "force-path-style"]],
  oss: [["bucket", "bucket"], ["path", "path"], ["region", "region"], ["endpoint", "endpoint"], ["forcePathStyle", "force-path-style"]],
  gs: [["bucket", "bucket"], ["path", "path"]],
  abs: [["accountName", "account-name"], ["bucket", "bucket"], ["path", "path"], ["endpoint", "endpoint"]],
  sftp: [["host", "host"], ["user", "user"], ["path", "path"], ["keyPath", "key-path"], ["hostKey", "host-key"]],
  webdav: [["webdavUrl", "webdav-url"], ["path", "path"]],
  nats: [["url", "url"]],
};

// Secret fields are emitted as ${VAR} PLACEHOLDERS, never values. litestream
// expands ${VAR} from its own environment at parse time, so the config file
// stays free of secrets while still telling litestream which credential goes
// where. sftp and nats have no auto-read variable, so the placeholder is the
// ONLY way to hand them a secret.
//
// s3 and oss are deliberately ABSENT: litestream reads LITESTREAM_ACCESS_KEY_ID
// / LITESTREAM_SECRET_ACCESS_KEY natively, so no placeholder is needed (and the
// config stays free of even the word "access-key"). This is the same mechanism
// production has been using all along.
const SECRET_PLACEHOLDERS = {
  abs: [["accountKey", "account-key", "LITESTREAM_AZURE_ACCOUNT_KEY"]],
  sftp: [["password", "password", "SFTP_PASSWORD"]],
  webdav: [["username", "webdav-username", "LITESTREAM_WEBDAV_USERNAME"], ["password", "webdav-password", "LITESTREAM_WEBDAV_PASSWORD"]],
  nats: [["username", "username", "NATS_USERNAME"], ["password", "password", "NATS_PASSWORD"]],
};

// Which env var names carry each type's secrets to the child. Kept beside the
// placeholders so a rename cannot desync the config from the environment.
const ENV_BINDINGS = {
  s3: [["accessKeyId", "LITESTREAM_ACCESS_KEY_ID"], ["accessKeySecret", "LITESTREAM_SECRET_ACCESS_KEY"]],
  oss: [["accessKeyId", "LITESTREAM_ACCESS_KEY_ID"], ["accessKeySecret", "LITESTREAM_SECRET_ACCESS_KEY"]],
  abs: [["accountKey", "LITESTREAM_AZURE_ACCOUNT_KEY"]],
  sftp: [["password", "SFTP_PASSWORD"]],
  webdav: [["username", "LITESTREAM_WEBDAV_USERNAME"], ["password", "LITESTREAM_WEBDAV_PASSWORD"]],
  nats: [["username", "NATS_USERNAME"], ["password", "NATS_PASSWORD"]],
};

function hasText(value) {
  return String(value ?? "").trim().length > 0;
}

// Build the litestream config for one destination. A `type:"url"` destination
// (the migrated legacy shape) keeps the plain `url:` shorthand it has always
// used, so an install that has not adopted a typed destination is byte-for-byte
// unchanged.
export function buildConfig(destination, { databasePath = DATA_FILE } = {}) {
  const type = String(destination?.type ?? "");
  const config = destination?.config ?? {};
  const header = [
    "# Generated by Spring Mouse — do not edit by hand.",
    "# Credentials are NOT in this file; they are passed to litestream via env.",
    "dbs:",
    `  - path: ${quote(databasePath)}`,
    "    replica:",
  ];

  if (type === "url") {
    const url = normalizeReplicaUrl(config.url);
    if (!url) throw new Error("A backup URL is required");
    return [...header, `      url: ${quote(url)}`, ""].join("\n");
  }

  const fields = REPLICA_FIELDS[type];
  if (!fields) throw new Error(`Unknown backup destination type: ${type}`);

  const lines = [...header, `      type: ${quote(type)}`];
  for (const [key, yamlName] of fields) {
    const value = config[key];
    if (typeof value === "boolean") {
      if (value) lines.push(`      ${yamlName}: true`);
    } else if (hasText(value)) {
      lines.push(`      ${yamlName}: ${quote(String(value).trim())}`);
    }
  }
  for (const [key, yamlName, envName] of SECRET_PLACEHOLDERS[type] ?? []) {
    if (hasText(destination?.secret?.[key])) lines.push(`      ${yamlName}: "\${${envName}}"`);
  }
  return [...lines, ""].join("\n");
}

// Env for the litestream child. Merges the operator's credentials over the
// parent env so PATH etc. survive. Empty credentials are omitted rather than
// set to "" — an empty string makes some SDKs send a blank Authorization
// header, which fails with a confusing 403 instead of "no credentials".
//
// `destination` may be a plain `{ type, config, secret }`; `secret` is the
// DECRYPTED credential object for that type.
export function buildEnv(destination, { baseEnv = process.env } = {}) {
  const env = { ...baseEnv };
  const type = String(destination?.type ?? "");
  const secret = destination?.secret ?? {};
  for (const [key, envName] of ENV_BINDINGS[type] ?? []) {
    const value = String(secret[key] ?? "").trim();
    if (value) env[envName] = value;
  }
  // oss also documents OSS_* names; set them alongside the generic pair.
  if (type === "oss") {
    if (hasText(secret.accessKeyId)) env.OSS_ACCESS_KEY_ID = String(secret.accessKeyId).trim();
    if (hasText(secret.accessKeySecret)) env.OSS_ACCESS_KEY_SECRET = String(secret.accessKeySecret).trim();
  }
  // `file` and `gs` need no credentials at all — nothing is added for them.
  return env;
}

