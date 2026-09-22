/**
 * Refresh-failure cooldown.
 *
 * A refresh token the upstream has declared permanently dead must not be
 * retried on every request. Production showed ~510 identical
 * `refresh_token_reused` failures over 9 hours (one every 1-3 minutes) for a
 * single account: `refreshLeadMs` for codex is 5 days, so an account whose
 * access token expires within that window is judged "needs refresh"
 * continuously; each attempt failed, the failure never advanced
 * `lastRefreshAt`, and the next request tried again.
 *
 * These tests lock in:
 *   - a permanent failure is recorded with a timestamp + code
 *   - shouldRefreshCredentials stops asking while the cooldown is active
 *   - a successful refresh clears the marker (re-authorised account recovers)
 *   - the marker survives updateProviderCredentials (it is allow-listed)
 *   - the cooldown is configurable / can be disabled
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...originalEnv };
});

async function loadManager() {
  return import("../../open-sse/services/oauthCredentialManager.js");
}

const HOUR = 60 * 60 * 1000;
const farFuture = () => new Date(Date.now() + 30 * 24 * HOUR).toISOString();

describe("refresh failure cooldown", () => {
  it("stamps a permanent failure with a timestamp and code", async () => {
    const { mergeRefreshedCredentials } = await loadManager();
    const now = Date.now();
    const merged = mergeRefreshedCredentials("codex",
      { connectionId: "c1", refreshToken: "dead", expiresAt: farFuture() },
      { error: "unrecoverable_refresh_error", code: "refresh_token_reused" },
      now,
    );

    expect(merged.lastRefreshFailureAt).toBe(new Date(now).toISOString());
    expect(merged.lastRefreshFailureCode).toBe("refresh_token_reused");
    // The failure must NOT look like a success.
    expect(merged.accessToken).toBeUndefined();
  });

  it("keeps the original failure timestamp when a later retry also fails", async () => {
    const { mergeRefreshedCredentials } = await loadManager();
    const first = Date.now() - 5 * 60 * 1000;
    // The failure object carries no timestamp of its own, so the EXISTING marker
    // (from the stored credentials) must win. Using `|| nowIso` here re-stamped
    // every attempt and restarted the cooldown, so suppression never engaged
    // (verified live: the stored timestamp advanced on each failure).
    const merged = mergeRefreshedCredentials("codex",
      { connectionId: "c1", refreshToken: "dead", lastRefreshFailureAt: new Date(first).toISOString() },
      { error: "unrecoverable_refresh_error", code: "refresh_token_reused" },
      Date.now(),
    );
    expect(merged.lastRefreshFailureAt).toBe(new Date(first).toISOString());
  });

  it("auth.js carries the marker into credentials (it is a field allow-list)", async () => {
    // getProviderCredentials builds its result field by field, so a field absent
    // from that list is invisible to shouldRefreshCredentials even when it is in
    // the stored row. This was the final gap that kept the storm alive in prod.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const src = fs.readFileSync(path.join(root, "src/sse/services/auth.js"), "utf-8");
    expect(src).toContain("lastRefreshFailureAt: connection.lastRefreshFailureAt");
    expect(src).toContain("lastRefreshFailureCode: connection.lastRefreshFailureCode");
  });

  it("does not ask to refresh while the failure cooldown is active", async () => {
    const { shouldRefreshCredentials } = await loadManager();
    // Access token expiring inside the 5-day codex lead window would normally
    // trigger a refresh — the cooldown must override that.
    const credentials = {
      connectionId: "c1",
      refreshToken: "dead",
      expiresAt: new Date(Date.now() + 3 * 24 * HOUR).toISOString(),
      lastRefreshFailureAt: new Date(Date.now() - 60 * 1000).toISOString(),
    };
    expect(shouldRefreshCredentials("codex", credentials)).toBe(false);
  });

  it("resumes asking once the cooldown has elapsed", async () => {
    const { shouldRefreshCredentials, REFRESH_FAILURE_COOLDOWN_MS } = await loadManager();
    // The stored row keeps the original credential fields; only the failure
    // marker is added. Construct it that way — mergeRefreshedCredentials returns
    // just the marker (see the "does not look like a success" assertion), so it
    // is not a valid stand-in for the stored row.
    const credentials = {
      connectionId: "c1",
      refreshToken: "dead",
      expiresAt: new Date(Date.now() + 3 * 24 * HOUR).toISOString(),
      lastRefreshFailureAt: new Date(Date.now() - REFRESH_FAILURE_COOLDOWN_MS - 1000).toISOString(),
    };
    expect(shouldRefreshCredentials("codex", credentials)).toBe(true);
  });

  it("clears the marker on a successful refresh so a re-authorised account recovers", async () => {
    const { mergeRefreshedCredentials } = await loadManager();
    const merged = mergeRefreshedCredentials("codex",
      { connectionId: "c1", refreshToken: "old", lastRefreshFailureAt: new Date().toISOString() },
      { accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600 },
    );
    expect(merged.lastRefreshFailureAt).toBeNull();
    expect(merged.lastRefreshFailureCode).toBeNull();
    expect(merged.accessToken).toBe("new-access");
    expect(merged.lastRefreshAt).toBeTruthy();
  });

  it("a cleared marker lets shouldRefreshCredentials consider the account again", async () => {
    const { shouldRefreshCredentials } = await loadManager();
    const credentials = {
      connectionId: "c1",
      refreshToken: "new-refresh",
      expiresAt: new Date(Date.now() + 3 * 24 * HOUR).toISOString(),
      lastRefreshFailureAt: null,
    };
    // Expiring inside the lead window → refresh again (recovered account).
    expect(shouldRefreshCredentials("codex", credentials)).toBe(true);
  });

  it("allows disabling the cooldown via env", async () => {
    process.env.SPRING_MOUSE_TOKEN_REFRESH_FAILURE_COOLDOWN_MS = "0";
    const { shouldRefreshCredentials, isRefreshFailureCoolingDown } = await loadManager();
    const credentials = {
      connectionId: "c1",
      refreshToken: "dead",
      expiresAt: new Date(Date.now() + 3 * 24 * HOUR).toISOString(),
      lastRefreshFailureAt: new Date().toISOString(),
    };
    expect(isRefreshFailureCoolingDown(credentials)).toBe(false);
    expect(shouldRefreshCredentials("codex", credentials)).toBe(true);
  });

  it("reads the marker from providerSpecificData too", async () => {
    const { isRefreshFailureCoolingDown } = await loadManager();
    expect(isRefreshFailureCoolingDown({
      providerSpecificData: { lastRefreshFailureAt: new Date().toISOString() },
    })).toBe(true);
  });

  it("updateProviderCredentials allow-lists the failure marker", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const src = fs.readFileSync(path.join(root, "src/sse/services/tokenRefresh.js"), "utf-8");
    // Persisting the marker is what makes the cooldown effective across requests.
    expect(src).toContain("lastRefreshFailureAt !== undefined");
    expect(src).toContain("updates.lastRefreshFailureAt");
    expect(src).toContain("updates.lastRefreshFailureCode");
  });

  it("chatCore persists the marker when a refresh permanently fails", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const src = fs.readFileSync(path.join(root, "open-sse/handlers/chatCore.js"), "utf-8");
    expect(src).toContain("newCredentials?.lastRefreshFailureAt");
    expect(src).toContain("onCredentialsRefreshed(newCredentials)");
  });

  it("checkAndRefreshToken persists the marker on the proactive path too", async () => {
    // This is the path that actually ran in production: chat.js calls
    // checkAndRefreshToken BEFORE the request, so a dead token is discovered
    // there, not in chatCore's post-401 handler. A fix that only covered chatCore
    // left the marker unwritten and the retry storm continued (verified live).
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const src = fs.readFileSync(path.join(root, "src/sse/services/tokenRefresh.js"), "utf-8");
    expect(src).toContain("newCreds?.lastRefreshFailureAt");
    expect(src).toContain("lastRefreshFailureAt: newCreds.lastRefreshFailureAt");
  });
});
