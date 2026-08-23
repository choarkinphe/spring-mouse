import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { decryptTotpSecret, verifyTotpCode } from "@/lib/auth/totp";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export async function POST(request) {
  try {
    const { code } = await request.json();
    const settings = await getSettings();
    if (!settings.totpPendingSecretEncrypted || !Array.isArray(settings.totpPendingRecoveryCodeHashes)) {
      return NextResponse.json({ error: "No pending two-factor setup" }, { status: 400, headers: NO_STORE_HEADERS });
    }

    const secret = decryptTotpSecret(settings.totpPendingSecretEncrypted);
    if (!verifyTotpCode(secret, code)) {
      return NextResponse.json({ error: "Invalid verification code" }, { status: 401, headers: NO_STORE_HEADERS });
    }

    await updateSettings({
      totpEnabled: true,
      totpSecretEncrypted: settings.totpPendingSecretEncrypted,
      totpRecoveryCodeHashes: settings.totpPendingRecoveryCodeHashes,
      totpPendingSecretEncrypted: null,
      totpPendingRecoveryCodeHashes: [],
    });
    return NextResponse.json({ success: true }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to enable two-factor authentication" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
