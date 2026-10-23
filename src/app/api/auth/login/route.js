import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { classifyLoginError, sanitizeLoginDiagnostic } from "@/lib/auth/loginDiagnostics";
import { getSettings } from "@/lib/localDb";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { clearDashboardMfaChallengeCookie, setDashboardAuthCookie, setDashboardMfaChallengeCookie } from "@/lib/auth/dashboardSession";
import { checkLock, recordFail, recordSuccess, getClientIp } from "@/lib/auth/loginLimiter";
import { isLocalRequest } from "@/dashboardGuard";

const RESET_HINT = "Forgot password? Reset to default via Spring Mouse CLI → Settings → Reset Password to Default.";
const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export async function POST(request) {
  let stage = "rate-limit";
  try {
    const ip = getClientIp(request);
    const lock = checkLock(ip);
    if (lock.locked) {
      return NextResponse.json(
        { error: `Too many failed attempts. Try again in ${lock.retryAfter}s. ${RESET_HINT}`, retryAfter: lock.retryAfter, resetHint: RESET_HINT },
        { status: 429, headers: { "Retry-After": String(lock.retryAfter) } }
      );
    }

    stage = "parse-body";
    const { password } = await request.json();
    stage = "settings";
    const settings = await getSettings();
    stage = "verify-password";

    // Default password is '123456' if not set
    const storedHash = settings.password;

    let isValid = false;
    if (storedHash) {
      isValid = await bcrypt.compare(password, storedHash);
    } else {
      // Use env var or default
      const initialPassword = process.env.INITIAL_PASSWORD || "123456";
      isValid = password === initialPassword;
    }

    if (isValid) {
      stage = "record-success";
      recordSuccess(ip);
      stage = "local-policy";

      // Default password still in use on a remote client → force a password
      // change before the dashboard is exposed remotely (keeps local UX intact).
      const mustChangePassword =
        !storedHash && !process.env.INITIAL_PASSWORD && !isLocalRequest(request);

      if (mustChangePassword) {
        // Do NOT issue a session token: a fresh install's default password is
        // public knowledge ("123456"), so handing out a valid JWT would let any
        // remote attacker authenticate and (e.g.) PATCH /api/settings to disable
        // authentication entirely (CVE-2026-56679 class). Require the password
        // to be changed first.
        //
        // NOTE: this intentionally leaves no remote self-service password-change
        // path — the change-password flow (PATCH /api/settings) requires a JWT,
        // which we deliberately withhold. A remote fresh-install user must either
        // change the password from the local machine or set INITIAL_PASSWORD
        // before first launch. This is a deliberate security trade-off, not an
        // oversight: issuing any credential before the default password is
        // rotated re-opens the exact attack chain this branch closes.
        return NextResponse.json(
          { success: false, error: "Default password must be changed before remote access. Change it from the local machine (or set INITIAL_PASSWORD).", mustChangePassword },
          { status: 403, headers: NO_STORE_HEADERS }
        );
      }

      stage = "cookie-store";
      const cookieStore = await cookies();
      if (settings.totpEnabled === true && settings.totpSecretEncrypted) {
        stage = "mfa-cookie";
        await setDashboardMfaChallengeCookie(cookieStore, request);
        stage = "response";
        return NextResponse.json(
          { success: true, mustChangePassword: false, requiresTotp: true },
          { headers: NO_STORE_HEADERS },
        );
      }

      stage = "clear-mfa-cookie";
      clearDashboardMfaChallengeCookie(cookieStore);
      stage = "auth-cookie";
      await setDashboardAuthCookie(cookieStore, request);
      stage = "response";
      return NextResponse.json({ success: true, mustChangePassword: false, requiresTotp: false }, { headers: NO_STORE_HEADERS });
    }

    stage = "record-failure";
    const { remainingBeforeLock } = recordFail(ip);
    const postLock = checkLock(ip);
    if (postLock.locked) {
      return NextResponse.json(
        { error: `Too many failed attempts. Try again in ${postLock.retryAfter}s. ${RESET_HINT}`, retryAfter: postLock.retryAfter, resetHint: RESET_HINT },
        { status: 429, headers: { "Retry-After": String(postLock.retryAfter) } }
      );
    }
    return NextResponse.json(
      { error: `Invalid password. ${remainingBeforeLock} attempt(s) left before lockout.`, remainingBeforeLock },
      { status: 401 }
    );
  } catch (error) {
    const diagnostic = sanitizeLoginDiagnostic({
      errorId: randomUUID(), stage, ...classifyLoginError(error, stage),
    });
    if (diagnostic.category !== "request-json") console.error(JSON.stringify(diagnostic));
    return NextResponse.json(
      { error: "Login failed", errorId: diagnostic.errorId },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
