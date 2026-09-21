import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Resolve repo files from THIS file's location, not process.cwd(). The suite is
// documented to run from tests/ (npx vitest), so cwd-relative paths silently
// failed for every assertion in this file.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoPath = (relative) => path.join(REPO_ROOT, relative);

// ============================================================
// AUDIT-002 (#1962): API key masking in usage stats
// ============================================================
// NOTE (2026-09 refactor): the usage aggregation moved out of usageRepo.js into
// runtime/usage-aggregate.mjs (shared by the web process and the aggregation
// worker). The byApiKey assertions below follow the logic to its new home.
//
// The original assertions looked for `apiKeyMasked` inside the akKey template.
// That never matched the running code: `usageHistory.apiKeyId` holds an internal
// id or an HMAC digest (`external:<sha256-prefix>`), never a raw key, so the
// bucket key is built from that non-secret value. These assertions now check the
// real contract: the DISPLAY field is masked and raw keys never reach the bucket.
describe("AUDIT-002: API key masking", () => {
  const readRepo = () => fs.readFileSync(repoPath("src/lib/db/repos/usageRepo.js"), "utf-8");
  const readAgg = () => fs.readFileSync(repoPath("runtime/usage-aggregate.mjs"), "utf-8");

  it("source should contain maskApiKey function", () => {
    expect(readRepo()).toContain("function maskApiKey");
  });

  it("getUsageHistory should expose apiKeyId, never a raw key", () => {
    const source = readRepo();
    const historyReturn = source.match(/return rows\.map\(\(r\)\s*=>\s*\(\{[\s\S]*?\}\)\);/);
    expect(historyReturn).not.toBeNull();
    // The field is the internal id (apiKeyId), not the raw credential.
    expect(historyReturn[0]).toContain("apiKeyId: r.apiKey");
    expect(historyReturn[0]).not.toContain("apiKey: r.apiKey");
  });

  it("byApiKey entries carry a masked display field, never the raw key", () => {
    const agg = readAgg();
    // Both the known-key and local-key branches set apiKeyMasked.
    const branches = agg.match(/stats\.byApiKey\[akKey\] = \{[^}]*apiKeyMasked[^}]*\}/g) || [];
    expect(branches.length).toBeGreaterThanOrEqual(2);
    // The raw credential must never be interpolated into the bucket object.
    expect(agg).not.toMatch(/apiKey:\s*r\.apiKey\s*[,}]/);
  });

  it("byApiKey bucket keys are built from the non-secret apiKeyId", () => {
    const agg = readAgg();
    // usageHistory.apiKeyId is an internal id or an HMAC digest — not a raw key.
    expect(agg).toContain("${r.apiKey}|${r.model}|${r.provider");
    // And the value stored in the bucket keeps the id for scoping, not the secret.
    expect(agg).toContain("apiKeyKey: r.apiKey");
  });
});

// ============================================================
// AUDIT-003 (#1961): Proxy URL validation
// ============================================================
describe("AUDIT-003: Proxy URL validation", () => {
  beforeEach(() => {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.ALL_PROXY;
    delete process.env.NINE_ROUTER_PROXY_MANAGED;
    delete process.env.NINE_ROUTER_PROXY_URL;
    delete process.env.NINE_ROUTER_NO_PROXY;
    delete process.env.NO_PROXY;
  });

  it("source should contain validateProxyUrl function", () => {
    const source = fs.readFileSync(
      repoPath("src/lib/network/outboundProxy.js"),
      "utf-8"
    );
    expect(source).toContain("function validateProxyUrl");
    expect(source).toContain("ALLOWED_PROXY_SCHEMES");
  });

  it("should accept valid http proxy URLs", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } = await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "http://proxy.example.com:8080",
    });
    // new URL().href normalizes (adds trailing slash)
    expect(process.env.HTTP_PROXY).toContain("http://proxy.example.com:8080");
    expect(process.env.HTTPS_PROXY).toContain("http://proxy.example.com:8080");
  });

  it("should accept valid https proxy URLs", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } = await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "https://proxy.example.com:443",
    });
    // new URL().href normalizes (drops default port 443, adds trailing slash)
    expect(process.env.HTTP_PROXY).toContain("https://proxy.example.com");
  });

  it("should accept valid socks5 proxy URLs", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } = await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "socks5://proxy.example.com:1080",
    });
    expect(process.env.ALL_PROXY).toBe("socks5://proxy.example.com:1080");
  });

  it("should reject URLs with shell metacharacters (newline)", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } = await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "http://proxy.example.com:8080\nmalicious",
    });
    expect(process.env.HTTP_PROXY).toBeUndefined();
  });

  it("should reject URLs with shell metacharacters (backtick)", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } = await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "http://`whoami`.example.com:8080",
    });
    expect(process.env.HTTP_PROXY).toBeUndefined();
  });

  it("should reject URLs with shell metacharacters (dollar)", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } = await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "http://$(whoami).example.com:8080",
    });
    expect(process.env.HTTP_PROXY).toBeUndefined();
  });

  it("should reject non-allowed schemes (file://)", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } = await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "file:///etc/passwd",
    });
    expect(process.env.HTTP_PROXY).toBeUndefined();
  });

  it("should reject non-allowed schemes (javascript:)", async () => {
    vi.resetModules();
    const { applyOutboundProxyEnv } = await import("../../src/lib/network/outboundProxy.js");
    applyOutboundProxyEnv({
      outboundProxyEnabled: true,
      outboundProxyUrl: "javascript:alert(1)",
    });
    expect(process.env.HTTP_PROXY).toBeUndefined();
  });
});

// ============================================================
// AUDIT-018 (#1972): XSS escaping in OAuth callback
// ============================================================
describe("AUDIT-018: XSS escaping in OAuth callback", () => {
  it("source should contain escapeHtml function", () => {
    const source = fs.readFileSync(
      repoPath("src/lib/oauth/utils/server.js"),
      "utf-8"
    );
    expect(source).toContain("function escapeHtml");
  });

  it("should escape ampersand, angle brackets, and quotes", () => {
    const source = fs.readFileSync(
      repoPath("src/lib/oauth/utils/server.js"),
      "utf-8"
    );
    expect(source).toContain("&amp;");
    expect(source).toContain("&lt;");
    expect(source).toContain("&gt;");
    expect(source).toContain("&quot;");
    expect(source).toContain("&#39;");
  });

  it("should use safeMessage in rendered HTML, not raw message", () => {
    const source = fs.readFileSync(
      repoPath("src/lib/oauth/utils/server.js"),
      "utf-8"
    );
    expect(source).toContain("safeMessage");
    expect(source).toContain("${safeMessage}");
    // Should NOT use raw message in HTML body
    expect(source).not.toContain("<p>${message}</p>");
  });
});

// ============================================================
// AUDIT-004 (#1963): TOCTOU race - atomic lock file
// ============================================================
describe("AUDIT-004: Atomic lock file for MITM startup", () => {
  it("manager.js should define LOCK_FILE constant", () => {
    const source = fs.readFileSync(
      repoPath("src/mitm/manager.js"),
      "utf-8"
    );
    expect(source).toContain("LOCK_FILE");
    expect(source).toContain(".mitm.lock");
  });

  it("should use O_EXCL flag (wx) for atomic creation", () => {
    const source = fs.readFileSync(
      repoPath("src/mitm/manager.js"),
      "utf-8"
    );
    expect(source).toContain('"wx"');
    expect(source).toContain("EEXIST");
  });

  it("should clean up lock file on all exit paths", () => {
    const source = fs.readFileSync(
      repoPath("src/mitm/manager.js"),
      "utf-8"
    );
    const matches = source.match(/unlinkSync\(LOCK_FILE\)/g);
    expect(matches).not.toBeNull();
    expect(matches.length).toBeGreaterThanOrEqual(4);
  });
});

// ============================================================
// AUDIT-001 (#1965): Race condition in retry tracking
// ============================================================
describe("AUDIT-001: Synchronous restart guard", () => {
  it("mitmIsRestarting should be set before first await expression", () => {
    const source = fs.readFileSync(
      repoPath("src/mitm/manager.js"),
      "utf-8"
    );

    const funcStart = source.indexOf("async function scheduleMitmRestart");
    expect(funcStart).toBeGreaterThan(-1);

    const funcBody = source.substring(funcStart, funcStart + 2000);

    const guardCheckIdx = funcBody.indexOf("if (mitmIsRestarting) return;");
    expect(guardCheckIdx).toBeGreaterThan(-1);

    const afterGuard = funcBody.substring(guardCheckIdx);

    // Strip line comments to avoid matching "await" in comment text
    const noComments = afterGuard.replace(/\/\/.*$/gm, "");

    // Find the first actual await expression
    const firstAwaitIdx = noComments.search(/\bawait\s+/);
    expect(firstAwaitIdx).toBeGreaterThan(-1);

    // Find mitmIsRestarting = true
    const setFlagIdx = noComments.indexOf("mitmIsRestarting = true");

    expect(setFlagIdx).toBeGreaterThan(-1);
    expect(firstAwaitIdx).toBeGreaterThan(-1);
    expect(setFlagIdx).toBeLessThan(firstAwaitIdx);
  });

  it("mitmIsRestarting should be reset on max-restarts early return", () => {
    const source = fs.readFileSync(
      repoPath("src/mitm/manager.js"),
      "utf-8"
    );

    const funcStart = source.indexOf("async function scheduleMitmRestart");
    const funcBody = source.substring(funcStart, funcStart + 2000);

    const maxRestartsIdx = funcBody.indexOf("Max restart attempts reached");
    expect(maxRestartsIdx).toBeGreaterThan(-1);

    const afterMax = funcBody.substring(maxRestartsIdx, maxRestartsIdx + 200);
    expect(afterMax).toContain("mitmIsRestarting = false");
  });
});
