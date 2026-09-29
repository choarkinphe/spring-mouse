import { NextResponse } from "next/server";
import { getSettings, updateSettings, getComboByName } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { resetComboRotation } from "open-sse/services/combo.js";
import { normalizeComboStrategies } from "open-sse/services/autoRouting.js";
import bcrypt from "bcryptjs";
import { normalizeIpRules } from "@/lib/auth/ipAccess";
import { normalizeAccessTags } from "@/shared/utils/accessTags";
import { normalizeClaudeMessagesRoute, getClaudeMessagesComboError } from "@/shared/utils/claudeMessagesRoute";
import { getActiveComboModels } from "open-sse/services/combo.js";
import { canDecryptBackupSecret } from "@/lib/backup/crypto";
import { getDefaultReplicaUrl } from "@/lib/backup/litestreamConfig";
import { listPublicDestinations } from "@/lib/backup/destinationsStore";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SETTINGS_RESPONSE_HEADERS = {
  "Cache-Control": "no-store"
};

// Secrets must never be mass-assigned from request body (CWE-915)
const PROTECTED_SETTING_KEYS = [
  "password", "mitmSudoEncrypted", "totpEnabled", "totpSecretEncrypted",
  "totpRecoveryCodeHashes", "totpPendingSecretEncrypted", "totpPendingRecoveryCodeHashes",
  // Backup credentials are written only through the encrypted path below, never
  // straight from the request body.
  "backupAccessKeyIdEncrypted", "backupAccessKeySecretEncrypted",
  // The destination list carries an encrypted secret blob per entry, the active
  // pointer decides what replicates, and the enable switch must start the engine
  // before it is persisted. All three are written by the dedicated endpoints
  // under /api/settings/backup/destinations, which validate and apply the engine
  // FIRST — mass-assigning them here would reintroduce the "400 but the row is
  // already enabled" ordering bug this replaced.
  "backupDestinations", "backupActiveDestinationId", "backupEnabled",
  // The legacy single-URL field is READ-ONLY now: nothing writes it, and the
  // engine only reads it as a fallback for an install migration 025 could not
  // convert. Leaving it mass-assignable would let a stale client create a
  // second, invisible source of truth beside the destination list.
  "backupReplicaUrl",
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
    backupAccessKeyIdEncrypted,
    backupAccessKeySecretEncrypted,
    // The stored list holds an encrypted secret blob per entry; it is replaced
    // below with a secret-free projection so the ciphertext never leaves the server.
    backupDestinations,
    ...safeSettings
  } = settings;
  safeSettings.cloudflareTunnelConfigured = !!cloudflareTunnelToken;
  safeSettings.totpEnabled = totpEnabled === true && !!totpSecretEncrypted;
  safeSettings.totpSetupPending = !!totpPendingSecretEncrypted;
  safeSettings.totpRecoveryCodeCount = Array.isArray(totpRecoveryCodeHashes) ? totpRecoveryCodeHashes.length : 0;
  // Report only whether credentials exist and are usable — never the values.
  // `canDecryptBackupSecret` also catches the case where the key file was lost,
  // so the UI can say "re-enter your credentials" instead of silently failing
  // at the first upload.
  safeSettings.backupCredentialsConfigured = canDecryptBackupSecret(backupAccessKeyIdEncrypted)
    && canDecryptBackupSecret(backupAccessKeySecretEncrypted);
  // The destination list, secret-free. `backupDestinations` is a PROTECTED key
  // so this projection is the only shape the client ever sees.
  safeSettings.backupDestinations = listPublicDestinations(settings);
  // The local path the UI pre-fills when no destination is set. Server-computed
  // so the client never has to guess the data directory.
  safeSettings.backupDefaultReplicaUrl = getDefaultReplicaUrl();
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

function normalizeApiKeyRateLimitRules(rules) {
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) {
    return { rpmLimit: null, rpmQueueMax: 0, queueTimeoutMs: null };
  }

  const parsePositive = (value) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };
  // Zero queue is a valid, meaningful setting: reject instead of waiting.
  const parseQueueMax = (value) => {
    if (value === null || value === undefined || value === "") return 0;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  };

  const rpmLimit = parsePositive(rules.rpmLimit);
  // No limit means no gate at all, so the other two knobs are meaningless.
  if (rpmLimit === null) return { rpmLimit: null, rpmQueueMax: 0, queueTimeoutMs: null };
  return {
    rpmLimit,
    rpmQueueMax: parseQueueMax(rules.rpmQueueMax),
    queueTimeoutMs: parsePositive(rules.queueTimeoutMs) ?? 60000,
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

    // Retention windows are consumed by the writer process to compute a delete
    // cutoff, so a malformed value must never reach the settings row: a negative
    // or non-numeric value would make the cutoff invalid, and the writer would
    // fall back to the default (silently ignoring the operator's intent).
    // Reject instead of coercing so the caller learns the input was wrong.
    for (const key of ["usageRetentionDays", "requestDetailsRetentionDays"]) {
      if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
      const value = body[key];
      const valid = typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3650;
      if (!valid) {
        return NextResponse.json(
          { error: `${key} must be an integer between 0 and 3650 (0 = keep forever)` },
          { status: 400 },
        );
      }
    }

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

    if (Object.prototype.hasOwnProperty.call(body, "usageDashboardScopeTags")) {
      body.usageDashboardScopeTags = normalizeAccessTags(body.usageDashboardScopeTags);
    }

    if (Object.prototype.hasOwnProperty.call(body, "claudeMessagesRoute")) {
      try {
        body.claudeMessagesRoute = normalizeClaudeMessagesRoute(body.claudeMessagesRoute);
        if (body.claudeMessagesRoute && !body.claudeMessagesRoute.includes("/")) {
          const combo = await getComboByName(body.claudeMessagesRoute);
          const activeModels = combo?.models ? getActiveComboModels(combo.models, new Date()) : null;
          const comboError = getClaudeMessagesComboError(combo, activeModels);
          if (comboError) throw new Error(comboError);
        }
      } catch (error) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }


    if (Object.prototype.hasOwnProperty.call(body, "modelAccessTags")) {
      const source = body.modelAccessTags && typeof body.modelAccessTags === "object" && !Array.isArray(body.modelAccessTags)
        ? body.modelAccessTags
        : {};
      body.modelAccessTags = Object.fromEntries(
        Object.entries(source)
          .filter(([modelId]) => typeof modelId === "string" && modelId.trim())
          .map(([modelId, tags]) => [modelId.trim(), normalizeAccessTags(tags)])
          .filter(([, tags]) => tags.length > 0),
      );
    }

    if (Object.prototype.hasOwnProperty.call(body, "providerChannelOrder")) {
      const order = Array.isArray(body.providerChannelOrder) ? body.providerChannelOrder : [];
      body.providerChannelOrder = [...new Set(
        order
          .filter((providerId) => typeof providerId === "string")
          .map((providerId) => providerId.trim())
          .filter(Boolean),
      )].slice(0, 500);
    }

    if (Object.prototype.hasOwnProperty.call(body, "apiKeyQuotaRules")) {
      body.apiKeyQuotaRules = normalizeApiKeyQuotaRules(body.apiKeyQuotaRules);
    }

    if (Object.prototype.hasOwnProperty.call(body, "apiKeyRateLimitRules")) {
      body.apiKeyRateLimitRules = normalizeApiKeyRateLimitRules(body.apiKeyRateLimitRules);
    }

    if (Object.prototype.hasOwnProperty.call(body, "cloudflareTunnelToken")) {
      if (!body.cloudflareTunnelToken || !String(body.cloudflareTunnelToken).trim()) {
        delete body.cloudflareTunnelToken;
      } else {
        body.cloudflareTunnelToken = String(body.cloudflareTunnelToken).trim();
      }
    }

    // Backup. The destination list, the active pointer and the enable switch are
    // all owned by the dedicated endpoints under /api/settings/backup/destinations
    // — which apply the engine BEFORE persisting, so a failed start cannot leave
    // the row enabled. Writing them here would reintroduce that ordering bug, so
    // they are PROTECTED (see PROTECTED_SETTING_KEYS) and the legacy single-URL
    // translation has been removed.

    if (Object.prototype.hasOwnProperty.call(body, "comboStrategies")) {
      try {
        body.comboStrategies = normalizeComboStrategies(body.comboStrategies, { strict: true });
      } catch (error) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }

    if (Object.prototype.hasOwnProperty.call(body, "providerStrategies")) {
    const source = body.providerStrategies && typeof body.providerStrategies === "object" && !Array.isArray(body.providerStrategies)
      ? body.providerStrategies
      : {};
    const positiveInt = (value) => {
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    };
    // Durations are stored in milliseconds. `*Seconds` is the documented client
    // contract; the raw `*Ms` form is accepted too so a caller that sends either
    // one is never silently dropped (a dropped duration quietly reverted to the
    // built-in default after every reload).
    const durationMs = (seconds, ms) => {
      const parsedSeconds = positiveInt(seconds);
      if (parsedSeconds) return parsedSeconds * 1000;
      return ms == null ? null : positiveInt(ms);
    };
    // Same as `durationMs` but 0 is a real value rather than "unset". Only for knobs
    // where 0 means "disabled" — for the rest, treating 0 as unset is what keeps a
    // blank dashboard field from silently switching a feature off.
    const durationMsAllowZero = (seconds, ms) => {
      const parsedSeconds = Number.parseInt(seconds, 10);
      if (Number.isFinite(parsedSeconds) && parsedSeconds >= 0) return parsedSeconds * 1000;
      const parsedMs = Number.parseInt(ms, 10);
      if (Number.isFinite(parsedMs) && parsedMs >= 0) return parsedMs;
      return null;
    };
    const normalize = (entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const result = {};
      if (entry.fallbackStrategy === "round-robin" || entry.fallbackStrategy === "request-round-robin") {
        result.fallbackStrategy = entry.fallbackStrategy;
      }
      const sticky = positiveInt(entry.stickyRoundRobinLimit);
      if (sticky) result.stickyRoundRobinLimit = sticky;
      const providerLimit = entry.providerMaxConcurrentStreams == null ? null : positiveInt(entry.providerMaxConcurrentStreams);
      if (entry.hardConcurrencyEnabled != null) result.hardConcurrencyEnabled = entry.hardConcurrencyEnabled === true;
      if (providerLimit) result.providerMaxConcurrentStreams = providerLimit;
      const accountLimit = entry.maxConcurrentStreams == null ? null : positiveInt(entry.maxConcurrentStreams);
      if (accountLimit) result.maxConcurrentStreams = accountLimit;
      const queueTimeoutMs = durationMs(entry.queueTimeoutSeconds, entry.queueTimeoutMs);
      if (queueTimeoutMs) result.queueTimeoutMs = queueTimeoutMs;
      const queueSize = entry.maxQueueSize == null ? null : positiveInt(entry.maxQueueSize);
      if (queueSize) result.maxQueueSize = queueSize;
      if (entry.enableModelBreaker != null) result.enableModelBreaker = entry.enableModelBreaker === true;
      const threshold = entry.breakerThreshold == null ? null : positiveInt(entry.breakerThreshold);
      if (threshold) result.breakerThreshold = threshold;
      const breakerWindowMs = durationMs(entry.breakerWindowSeconds, entry.breakerWindowMs);
      if (breakerWindowMs) result.breakerWindowMs = breakerWindowMs;
      const breakerCooldownMs = durationMs(entry.breakerCooldownSeconds, entry.breakerCooldownMs);
      if (breakerCooldownMs != null) result.breakerCooldownMs = breakerCooldownMs;
      // Model-level overload throttle. Separate from the breaker above on purpose:
      // an overloaded model needs a few seconds of breathing room, not a minute of
      // whole-model outage. Tunable here so it can be adjusted without a release.
      const overloadThreshold = entry.overloadThreshold == null ? null : positiveInt(entry.overloadThreshold);
      if (overloadThreshold) result.overloadThreshold = overloadThreshold;
      const overloadCooldownMs = durationMs(entry.overloadCooldownSeconds, entry.overloadCooldownMs);
      if (overloadCooldownMs != null) result.overloadCooldownMs = overloadCooldownMs;
      const overloadWaitMs = durationMs(entry.overloadWaitSeconds, entry.overloadWaitMs);
      if (overloadWaitMs != null) result.overloadWaitMs = overloadWaitMs;
      const overloadMaxRetries = (() => {
        if (entry.overloadMaxRetries == null || entry.overloadMaxRetries === "") return null;
        const parsed = Number.parseInt(entry.overloadMaxRetries, 10);
        if (!Number.isFinite(parsed) || parsed < 0) return null;
        return Math.min(10, parsed);
      })();
      if (overloadMaxRetries != null) result.overloadMaxRetries = overloadMaxRetries;
      // SSE-overload retry curve for a 200-OK stream that carries an error frame
      // ("Our servers are currently overloaded"). Separate from the throttle above:
      // that one paces a *busy* model across requests, this one governs how long a
      // single request keeps retrying the same model before giving up. Tunable per
      // channel so a saturated provider can be waited out without a release.
      const overloadRetryBudgetMs = durationMs(entry.overloadRetryBudgetSeconds, entry.overloadRetryBudgetMs);
      if (overloadRetryBudgetMs != null) result.overloadRetryBudgetMs = overloadRetryBudgetMs;
      const overloadRetryBaseDelayMs = durationMs(entry.overloadRetryBaseDelaySeconds, entry.overloadRetryBaseDelayMs);
      if (overloadRetryBaseDelayMs != null) result.overloadRetryBaseDelayMs = overloadRetryBaseDelayMs;
      const overloadRetryMaxDelayMs = durationMs(entry.overloadRetryMaxDelaySeconds, entry.overloadRetryMaxDelayMs);
      if (overloadRetryMaxDelayMs != null) result.overloadRetryMaxDelayMs = overloadRetryMaxDelayMs;
      // How much budget a retry must have left to be started at all. An attempt
      // costs 10-30s to reach a first token, so a retry started with less room is
      // cut off by the scan deadline and reported as an overload it is not — and it
      // spends budget the combo's remaining models need. 0 disables the guard.
      const overloadRetryMinAttemptMs = durationMsAllowZero(entry.overloadRetryMinAttemptSeconds, entry.overloadRetryMinAttemptMs);
      if (overloadRetryMinAttemptMs != null) result.overloadRetryMinAttemptMs = overloadRetryMinAttemptMs;
      return Object.keys(result).length ? result : null;
    };
    body.providerStrategies = Object.fromEntries(
      Object.entries(source)
        .filter(([providerId]) => typeof providerId === "string" && providerId.trim())
        .map(([providerId, entry]) => [providerId.trim().slice(0, 100), normalize(entry)])
        .filter(([, entry]) => Boolean(entry)),
    );
  }

  const settings = await updateSettings(body);

    if (Object.prototype.hasOwnProperty.call(body, "usageDashboardScopeTags")) {
      // Refresh every open usage-dashboard SSE stream so the persisted scope
      // takes effect outside the page that initiated the change as well.
      import("@/lib/usageDb")
        .then(({ notifyUsageCommitted }) => notifyUsageCommitted())
        .catch(() => {});
    }

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

    if (Object.prototype.hasOwnProperty.call(body, "pricingAutoSyncEnabled")) {
      // Start or stop the periodic pricing refresh to match the new setting.
      import("@/shared/services/pricingAutoSync")
        .then(({ configurePricingAutoSync }) => {
          configurePricingAutoSync(settings);
        })
        .catch((error) => console.warn("[PricingAutoSync] settings update failed:", error.message));
    }

    return NextResponse.json(toSafeSettings(settings), { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error updating settings:", error);
    return NextResponse.json({ error: error.message }, { status: isSettingsValidationError(error) ? 400 : 500 });
  }
}
