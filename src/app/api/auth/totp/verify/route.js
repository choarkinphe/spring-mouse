import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSettings, updateSettings } from "@/lib/localDb";
import {
  clearDashboardMfaChallengeCookie,
  setDashboardAuthCookie,
  verifyDashboardMfaChallengeToken,
} from "@/lib/auth/dashboardSession";
import { decryptTotpSecret, findRecoveryCodeIndex, verifyTotpCode } from "@/lib/auth/totp";
import { checkMfaLock, getClientIp, recordMfaFail, recordMfaSuccess } from "@/lib/auth/loginLimiter";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export async function POST(request) {
  const ip = getClientIp(request);
  const lock = checkMfaLock(ip);
  if (lock.locked) {
    return NextResponse.json(
      { error: `Too many verification attempts. Try again in ${lock.retryAfter}s.`, retryAfter: lock.retryAfter },
      { status: 429, headers: { ...NO_STORE_HEADERS, "Retry-After": String(lock.retryAfter) } },
    );
  }

  try {
    const cookieStore = await cookies();
    const challenge = cookieStore.get("auth_mfa_challenge")?.value;
    if (!(await verifyDashboardMfaChallengeToken(challenge))) {
      return NextResponse.json({ error: "Two-factor challenge expired. Sign in again." }, { status: 401, headers: NO_STORE_HEADERS });
    }

    const { code } = await request.json();
    const settings = await getSettings();
    if (settings.totpEnabled !== true || !settings.totpSecretEncrypted) {
      clearDashboardMfaChallengeCookie(cookieStore);
      return NextResponse.json({ error: "Two-factor authentication is not configured" }, { status: 400, headers: NO_STORE_HEADERS });
    }

    const secret = decryptTotpSecret(settings.totpSecretEncrypted);
    const validTotp = verifyTotpCode(secret, code);
    const recoveryCodeIndex = validTotp ? -1 : await findRecoveryCodeIndex(code, settings.totpRecoveryCodeHashes);
    if (!validTotp && recoveryCodeIndex === -1) {
      const { remainingBeforeLock } = recordMfaFail(ip);
      const postLock = checkMfaLock(ip);
      return NextResponse.json(
        {
          error: postLock.locked
            ? `Too many verification attempts. Try again in ${postLock.retryAfter}s.`
            : `Invalid verification code. ${remainingBeforeLock} attempt(s) left before lockout.`,
          retryAfter: postLock.retryAfter,
        },
        {
          status: postLock.locked ? 429 : 401,
          headers: postLock.locked ? { ...NO_STORE_HEADERS, "Retry-After": String(postLock.retryAfter) } : NO_STORE_HEADERS,
        },
      );
    }

    if (recoveryCodeIndex !== -1) {
      const nextRecoveryCodes = [...settings.totpRecoveryCodeHashes];
      nextRecoveryCodes.splice(recoveryCodeIndex, 1);
      await updateSettings({ totpRecoveryCodeHashes: nextRecoveryCodes });
    }

    recordMfaSuccess(ip);
    clearDashboardMfaChallengeCookie(cookieStore);
    await setDashboardAuthCookie(cookieStore, request, { mfa: "totp" });
    return NextResponse.json({ success: true, usedRecoveryCode: recoveryCodeIndex !== -1 }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to verify two-factor code" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
