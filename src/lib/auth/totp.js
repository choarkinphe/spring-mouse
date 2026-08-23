import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { DATA_DIR } from "@/lib/dataDir";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const DEFAULT_PERIOD_SECONDS = 30;
const DEFAULT_DIGITS = 6;
const RECOVERY_CODE_COUNT = 8;

function decodeBase32(value) {
  const normalized = String(value || "").toUpperCase().replace(/[\s=-]/g, "");
  if (!normalized || /[^A-Z2-7]/.test(normalized)) return null;

  let bits = 0;
  let bitCount = 0;
  const bytes = [];
  for (const char of normalized) {
    bits = (bits << 5) | BASE32_ALPHABET.indexOf(char);
    bitCount += 5;
    if (bitCount >= 8) {
      bytes.push((bits >> (bitCount - 8)) & 0xff);
      bitCount -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(byteLength = 20) {
  const bytes = crypto.randomBytes(byteLength);
  let output = "";
  let bits = 0;
  let bitCount = 0;
  for (const byte of bytes) {
    bits = (bits << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      output += BASE32_ALPHABET[(bits >> (bitCount - 5)) & 31];
      bitCount -= 5;
    }
  }
  if (bitCount > 0) output += BASE32_ALPHABET[(bits << (5 - bitCount)) & 31];
  return output;
}

export function createTotpUri({ secret, accountName = "Dashboard", issuer = "Spring Mouse" }) {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DEFAULT_DIGITS),
    period: String(DEFAULT_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export function verifyTotpCode(secret, code, {
  timestamp = Date.now(),
  periodSeconds = DEFAULT_PERIOD_SECONDS,
  digits = DEFAULT_DIGITS,
  window = 1,
} = {}) {
  const key = decodeBase32(secret);
  const normalizedCode = String(code || "").replace(/\s/g, "");
  if (!key || !new RegExp(`^\\d{${digits}}$`).test(normalizedCode)) return false;

  const counter = Math.floor(timestamp / 1000 / periodSeconds);
  for (let offset = -window; offset <= window; offset += 1) {
    if (counter + offset < 0) continue;
    const movingFactor = Buffer.alloc(8);
    movingFactor.writeBigUInt64BE(BigInt(counter + offset));
    const digest = crypto.createHmac("sha1", key).update(movingFactor).digest();
    const index = digest[digest.length - 1] & 0x0f;
    const truncated = ((digest[index] & 0x7f) << 24)
      | (digest[index + 1] << 16)
      | (digest[index + 2] << 8)
      | digest[index + 3];
    const expected = String(truncated % (10 ** digits)).padStart(digits, "0");
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(normalizedCode))) return true;
  }
  return false;
}

function loadEncryptionKey() {
  const supplied = process.env.TOTP_ENCRYPTION_KEY;
  if (supplied) {
    const value = /^[a-f0-9]{64}$/i.test(supplied)
      ? Buffer.from(supplied, "hex")
      : Buffer.from(supplied, "base64");
    if (value.length !== 32) throw new Error("TOTP_ENCRYPTION_KEY must encode exactly 32 bytes");
    return value;
  }

  const file = path.join(DATA_DIR, "totp-encryption-key");
  try {
    const saved = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
    if (saved.length === 32) return saved;
  } catch {}

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const generated = crypto.randomBytes(32);
  fs.writeFileSync(file, generated.toString("base64"), { mode: 0o600 });
  return generated;
}

function getEncryptionKey() {
  return loadEncryptionKey();
}

export function encryptTotpSecret(secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptTotpSecret(payload) {
  const [version, ivText, tagText, ciphertextText] = String(payload || "").split(".");
  if (version !== "v1" || !ivText || !tagText || !ciphertextText) throw new Error("Invalid encrypted TOTP secret");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getEncryptionKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]).toString("utf8");
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  return Array.from({ length: count }, () => {
    const value = crypto.randomBytes(5).toString("hex").toUpperCase();
    return `${value.slice(0, 5)}-${value.slice(5)}`;
  });
}

export async function hashRecoveryCodes(codes) {
  return Promise.all(codes.map((code) => bcrypt.hash(code, 10)));
}

export async function findRecoveryCodeIndex(code, hashes = []) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!/^[A-F0-9]{5}-[A-F0-9]{5}$/.test(normalized)) return -1;
  for (let index = 0; index < hashes.length; index += 1) {
    if (await bcrypt.compare(normalized, hashes[index])) return index;
  }
  return -1;
}
