import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { resetComboRotation } from "open-sse/services/combo.js";
import bcrypt from "bcryptjs";
import { normalizeIpRules } from "@/lib/auth/ipAccess";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SETTINGS_RESPONSE_HEADERS = {
  "Cache-Control": "no-store"
};

// Secrets must never be mass-assigned from request body (CWE-915)
const PROTECTED_SETTING_KEYS = [
  "password", "mitmSudoEncrypted", "totpEnabled", "totpSecretEncrypted",
  "totpRecoveryCodeHashes", "totpPendingSecretEncrypted", "totpPendingRecoveryCodeHashes",
];
const RETIRED_SSO_SETTING_KEYS = [
  "authMode", "ssoType", "oidcIssuerUrl", "oidcClientId", "oidcClientSecret",
  "oidcScopes", "oidcLoginLabel", "samlEntryPoint", "samlIssuer", "samlCert",
  "samlLoginLabel", "samlAttributeEmail", "samlAttributeName",
];

function toSafeSettings(settings) {
  const {
    password,
    cloudflareTunnelToken,
    totpEnabled,
    totpSecretEncrypted,
    totpRecoveryCodeHashes,
    totpPendingSecretEncrypted,
    totpPendingRecoveryCodeHashes,
    ...safeSettings
  } = settings;
  safeSettings.cloudflareTunnelConfigured = !!cloudflareTunnelToken;
  safeSettings.totpEnabled = totpEnabled === true && !!totpSecretEncrypted;
  safeSettings.totpSetupPending = !!totpPendingSecretEncrypted;
  safeSettings.totpRecoveryCodeCount = Array.isArray(totpRecoveryCodeHashes) ? totpRecoveryCodeHashes.length : 0;
  return safeSettings;
}

function isSettingsValidationError(error) {
  const message = error instanceof Error ? error.message : "";
  return message.startsWith("Invalid IP") || message.startsWith("IP access") || message.includes("IP allowlist") || message.includes("IP blocklist");
}

function normalizeIpAccessMode(value) {
  if (value === "allowlist" || value === "blocklist") return value;
  throw new Error("IP access mode must be allowlist or blocklist");
}

function normalizeApiKeyQuotaRules(rules) {
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) {
    return { fiveHourTokenLimitM: null, weeklyTokenLimitM: null };
  }

  const parseLimit = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };

  return {
    fiveHourTokenLimitM: parseLimit(rules.fiveHourTokenLimitM),
    weeklyTokenLimitM: parseLimit(rules.weeklyTokenLimitM),
  };
}

export async function GET() {
  try {
    const settings = await getSettings();
    const safeSettings = toSafeSettings(settings);

    const enableTranslator = process.env.ENABLE_TRANSLATOR === "true";

    return NextResponse.json({
      ...safeSettings,
      enableTranslator,
      hasPassword: !!settings.password
    }, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error getting settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Settings update must be an object" }, { status: 400 });
    }

    // Strip protected secrets and retired SSO fields before saving.
    for (const key of [...PROTECTED_SETTING_KEYS, ...RETIRED_SSO_SETTING_KEYS]) delete body[key];

    let currentSettings;
    const getCurrentSettings = async () => {
      if (!currentSettings) currentSettings = await getSettings();
      return currentSettings;
    };

    // If updating password, hash it
    if (body.newPassword) {
      const settings = await getCurrentSettings();
      const currentHash = settings.password;

      // Verify current password if it exists
      if (currentHash) {
        if (!body.currentPassword) {
          return NextResponse.json({ error: "Current password required" }, { status: 400 });
        }
        const isValid = await bcrypt.compare(body.currentPassword, currentHash);
        if (!isValid) {
          return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      } else {
        // First time setting password, no current password needed
        // Allow empty currentPassword or default "123456"
        if (body.currentPassword && body.currentPassword !== "123456") {
           return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      }

      const salt = await bcrypt.genSalt(10);
      body.password = await bcrypt.hash(body.newPassword, salt);
      delete body.newPassword;
      delete body.currentPassword;
    }

    const updatesIpAccess = ["ipAccessEnabled", "ipAccessMode", "ipAllowlist", "ipBlocklist"]
      .some((key) => Object.prototype.hasOwnProperty.call(body, key));
    if (updatesIpAccess) {
      const current = await getCurrentSettings();
      if (Object.prototype.hasOwnProperty.call(body, "ipAccessEnabled")) {
        body.ipAccessEnabled = body.ipAccessEnabled === true;
      }
      if (Object.prototype.hasOwnProperty.call(body, "ipAccessMode")) {
        body.ipAccessMode = normalizeIpAccessMode(body.ipAccessMode);
      }
      if (Object.prototype.hasOwnProperty.call(body, "ipAllowlist")) {
        body.ipAllowlist = normalizeIpRules(body.ipAllowlist, "IP allowlist");
      }
      if (Object.prototype.hasOwnProperty.call(body, "ipBlocklist")) {
        body.ipBlocklist = normalizeIpRules(body.ipBlocklist, "IP blocklist");
      }

      const mode = body.ipAccessMode || current.ipAccessMode || "allowlist";
      const enabled = Object.prototype.hasOwnProperty.call(body, "ipAccessEnabled")
        ? body.ipAccessEnabled
        : current.ipAccessEnabled === true;
      const activeRules = mode === "allowlist"
        ? (body.ipAllowlist ?? current.ipAllowlist ?? [])
        : (body.ipBlocklist ?? current.ipBlocklist ?? []);
      if (enabled && mode === "allowlist" && activeRules.length === 0) {
        return NextResponse.json(
          { error: "IP allowlist mode requires at least one rule before it can be enabled" },
          { status: 400 },
        );
      }
    }

    if (Object.prototype.hasOwnProperty.call(body, "apiKeyQuotaRules")) {
      body.apiKeyQuotaRules = normalizeApiKeyQuotaRules(body.apiKeyQuotaRules);
    }

    if (Object.prototype.hasOwnProperty.call(body, "cloudflareTunnelToken")) {
      if (!body.cloudflareTunnelToken || !String(body.cloudflareTunnelToken).trim()) {
        delete body.cloudflareTunnelToken;
      } else {
        body.cloudflareTunnelToken = String(body.cloudflareTunnelToken).trim();
      }
    }

    const settings = await updateSettings(body);

    // Apply outbound proxy settings immediately (no restart required)
    if (
      Object.prototype.hasOwnProperty.call(body, "outboundProxyEnabled") ||
      Object.prototype.hasOwnProperty.call(body, "outboundProxyUrl") ||
      Object.prototype.hasOwnProperty.call(body, "outboundNoProxy")
    ) {
      applyOutboundProxyEnv(settings);
    }

    // Invalidate combo rotation state when per-combo strategy settings change.
    if (Object.prototype.hasOwnProperty.call(body, "comboStrategies")) {
      resetComboRotation();
    }

    if (
      Object.prototype.hasOwnProperty.call(body, "claudeAutoPing") ||
      Object.prototype.hasOwnProperty.call(body, "codexAutoPing")
    ) {
      // Keep the scheduler absent when no account opted in; load its provider graph only on demand.
      import("@/shared/services/quotaAutoPing")
        .then(({ configureQuotaAutoPing }) => {
          configureQuotaAutoPing(settings);
        })
        .catch((error) => console.warn("[AutoPing] settings update failed:", error.message));
    }

    return NextResponse.json(toSafeSettings(settings), { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error updating settings:", error);
    return NextResponse.json({ error: error.message }, { status: isSettingsValidationError(error) ? 400 : 500 });
  }
}
