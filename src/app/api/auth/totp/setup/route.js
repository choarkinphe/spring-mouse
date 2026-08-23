import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { verifyDashboardPassword } from "@/lib/auth/dashboardSession";
import {
  createTotpUri,
  encryptTotpSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCodes,
} from "@/lib/auth/totp";
import QRCode from "qrcode";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export async function POST(request) {
  try {
    const { password } = await request.json();
    if (!(await verifyDashboardPassword(password))) {
      return NextResponse.json({ error: "Invalid current password" }, { status: 401, headers: NO_STORE_HEADERS });
    }

    const settings = await getSettings();
    const secret = generateTotpSecret();
    const recoveryCodes = generateRecoveryCodes();
    const otpauthUrl = createTotpUri({ issuer: "Spring Mouse", accountName: "Dashboard" , secret });
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 280,
    });

    await updateSettings({
      totpPendingSecretEncrypted: encryptTotpSecret(secret),
      totpPendingRecoveryCodeHashes: await hashRecoveryCodes(recoveryCodes),
      // Starting a new setup invalidates a previous unconfirmed enrollment.
      totpEnabled: settings.totpEnabled === true && !!settings.totpSecretEncrypted,
    });

    return NextResponse.json({
      success: true,
      qrCodeDataUrl,
      manualKey: secret,
      recoveryCodes,
    }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to start two-factor setup" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
