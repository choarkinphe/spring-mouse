// Secret storage for backup credentials — AES-256-GCM, same construction as
// src/lib/auth/totp.js (v1.<iv>.<tag>.<ciphertext>, base64url).
//
// WHY A SEPARATE KEY FROM TOTP: they protect different things and rotate for
// different reasons. Sharing one key would mean rotating the backup credential
// also invalidates every TOTP secret.
//
// ⚠️ WHAT THIS KEY DOES *NOT* DO: it does not encrypt the database backup.
// Litestream writes the replica, and the storage provider encrypts it at rest
// (OSS SSE-KMS / S3 SSE). This key only protects the AccessKey pair sitting in
// the settings row, so a leaked settings dump does not hand over write access
// to the backup bucket.
//
// CONSEQUENCE: losing this key costs you the stored credentials, not the
// backup. Recovery is "type the AccessKey again". Set SPRING_MOUSE_BACKUP_KEY
// to avoid even that (it also survives a whole-machine loss, unlike the file).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";

const KEY_FILE = path.join(DATA_DIR, "backup-encryption-key");
const VERSION = "v1";

function loadEncryptionKey() {
  const supplied = process.env.SPRING_MOUSE_BACKUP_KEY;
  if (supplied) {
    const value = /^[a-f0-9]{64}$/i.test(supplied)
      ? Buffer.from(supplied, "hex")
      : Buffer.from(supplied, "base64");
    if (value.length !== 32) throw new Error("SPRING_MOUSE_BACKUP_KEY must encode exactly 32 bytes");
    return value;
  }

  try {
    const saved = Buffer.from(fs.readFileSync(KEY_FILE, "utf8").trim(), "base64");
    if (saved.length === 32) return saved;
  } catch {}

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const generated = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, generated.toString("base64"), { mode: 0o600 });
  return generated;
}

export function encryptBackupSecret(secret) {
  const value = String(secret ?? "");
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", loadEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptBackupSecret(payload) {
  const [version, ivText, tagText, ciphertextText] = String(payload || "").split(".");
  if (version !== VERSION || !ivText || !tagText || !ciphertextText) {
    throw new Error("Invalid encrypted backup secret");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", loadEncryptionKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]).toString("utf8");
}

// True when a value is present and decryptable with the current key. Used to
// report "credentials configured" without ever sending them to the client.
export function canDecryptBackupSecret(payload) {
  if (!payload) return false;
  try {
    decryptBackupSecret(payload);
    return true;
  } catch {
    return false;
  }
}
