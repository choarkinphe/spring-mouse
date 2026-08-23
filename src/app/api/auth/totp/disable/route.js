import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { verifyDashboardPassword } from "@/lib/auth/dashboardSession";
import { decryptTotpSecret, findRecoveryCodeIndex, verifyTotpCode } from "@/lib/auth/totp";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export async function POST(request) {
  try {
    const { password, code } = await request.json();
    if (!(await verifyDashboardPassword(password))) {
      return NextResponse.json({ error: "Invalid current password" }, { status: 401, headers: NO_STORE_HEADERS });
    }

    const settings = await getSettings();
    if (settings.totpEnabled !== true || !settings.totpSecretEncrypted) {
      return NextResponse.json({ error: "Two-factor authentication is not enabled" }, { status: 400, headers: NO_STORE_HEADERS });
    }

    const secret = decryptTotpSecret(settings.totpSecretEncrypted);
    const validTotp = verifyTotpCode(secret, code);
    const recoveryCodeIndex = validTotp ? -1 : await findRecoveryCodeIndex(code, settings.totpRecoveryCodeHashes);
    if (!validTotp && recoveryCodeIndex === -1) {
      return NextResponse.json({ error: "Invalid verification or recovery code" }, { status: 401, headers: NO_STORE_HEADERS });
    }

    await updateSettings({
      totpEnabled: false,
      totpSecretEncrypted: null,
      totpRecoveryCodeHashes: [],
      totpPendingSecretEncrypted: null,
      totpPendingRecoveryCodeHashes: [],
    });
    return NextResponse.json({ success: true }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to disable two-factor authentication" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
