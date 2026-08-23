import { afterEach, describe, expect, it } from "vitest";
import {
  createTotpUri,
  decryptTotpSecret,
  encryptTotpSecret,
  findRecoveryCodeIndex,
  generateRecoveryCodes,
  hashRecoveryCodes,
  verifyTotpCode,
} from "@/lib/auth/totp.js";

const originalEncryptionKey = process.env.TOTP_ENCRYPTION_KEY;

afterEach(() => {
  if (originalEncryptionKey === undefined) delete process.env.TOTP_ENCRYPTION_KEY;
  else process.env.TOTP_ENCRYPTION_KEY = originalEncryptionKey;
});

describe("TOTP authentication", () => {
  const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // ASCII "12345678901234567890"

  it("verifies RFC 6238 time-based codes and accepts a small clock-skew window", () => {
    expect(verifyTotpCode(rfcSecret, "94287082", { timestamp: 59_000, digits: 8, window: 0 })).toBe(true);
    expect(verifyTotpCode(rfcSecret, "287082", { timestamp: 59_000, digits: 6, window: 0 })).toBe(true);
    expect(verifyTotpCode(rfcSecret, "287082", { timestamp: 89_000, digits: 6, window: 1 })).toBe(true);
    expect(verifyTotpCode(rfcSecret, "287082", { timestamp: 120_000, digits: 6, window: 0 })).toBe(false);
  });

  it("creates a standard provisioning URI", () => {
    const uri = createTotpUri({ secret: rfcSecret, issuer: "Spring Mouse", accountName: "Dashboard" });
    expect(uri).toContain("otpauth://totp/Spring%20Mouse%3ADashboard?");
    expect(uri).toContain(`secret=${rfcSecret}`);
    expect(uri).toContain("issuer=Spring+Mouse");
  });

  it("encrypts the TOTP secret and consumes recovery codes once", async () => {
    process.env.TOTP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    const encrypted = encryptTotpSecret(rfcSecret);
    expect(encrypted).not.toContain(rfcSecret);
    expect(decryptTotpSecret(encrypted)).toBe(rfcSecret);

    const codes = generateRecoveryCodes(2);
    expect(codes).toHaveLength(2);
    const hashes = await hashRecoveryCodes(codes);
    expect(await findRecoveryCodeIndex(codes[1], hashes)).toBe(1);
    expect(await findRecoveryCodeIndex("ABCDE-12345", hashes)).toBe(-1);
  });
});
