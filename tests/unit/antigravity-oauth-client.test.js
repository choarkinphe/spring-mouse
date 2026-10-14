import { describe, it, expect, vi, afterEach } from "vitest";
import antigravity from "../../src/lib/oauth/providers/antigravity.js";
import { ANTIGRAVITY_OAUTH_CLIENT, GOOGLE_OAUTH_CLIENT } from "../../open-sse/providers/shared.js";

describe("Antigravity OAuth configuration validation", () => {
  const config = {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientId: "test-client.apps.googleusercontent.com",
    clientSecret: "test-secret",
    scopes: ["openid", "email"],
  };
  const redirectUri = "http://localhost:8007/callback";

  afterEach(() => vi.unstubAllGlobals());

  it.each(["", "   ", undefined, null])("rejects a missing client ID (%s) before opening Google", (clientId) => {
    expect(() => antigravity.buildAuthUrl({ ...config, clientId }, redirectUri, "state"))
      .toThrow("ANTIGRAVITY_OAUTH_CLIENT_ID");
  });

  it.each(["", "   ", undefined, null])("rejects a missing client secret (%s) before opening Google", (clientSecret) => {
    expect(() => antigravity.buildAuthUrl({ ...config, clientSecret }, redirectUri, "state"))
      .toThrow("ANTIGRAVITY_OAUTH_CLIENT_SECRET");
  });

  it("reports both missing fields without exposing supplied values", () => {
    expect(() => antigravity.buildAuthUrl({ ...config, clientId: "", clientSecret: "" }, redirectUri, "state"))
      .toThrow("ANTIGRAVITY_OAUTH_CLIENT_ID、ANTIGRAVITY_OAUTH_CLIENT_SECRET");
    try {
      antigravity.buildAuthUrl({ ...config, clientId: "" }, redirectUri, "state");
    } catch (error) {
      expect(error.message).not.toContain(config.clientSecret);
    }
  });

  it("builds a valid authorization URL without the client secret", () => {
    const url = new URL(antigravity.buildAuthUrl(config, redirectUri, "test-state"));
    expect(url.searchParams.get("client_id")).toBe(config.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(url.searchParams.get("state")).toBe("test-state");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("scope")).toBe("openid email");
    expect(url.toString()).not.toContain(config.clientSecret);
  });

  it("does not send a token request with missing configuration", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(antigravity.exchangeToken({ ...config, clientSecret: "" }, "code", redirectUri))
      .rejects.toThrow("ANTIGRAVITY_OAUTH_CLIENT_SECRET");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exchanges a code using the configured client", async () => {
    const tokens = { access_token: "test-access", refresh_token: "test-refresh" };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => tokens });
    vi.stubGlobal("fetch", fetchMock);
    await expect(antigravity.exchangeToken(config, "test-code", redirectUri)).resolves.toEqual(tokens);
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe(config.tokenUrl);
    expect(request.body.get("client_id")).toBe(config.clientId);
    expect(request.body.get("client_secret")).toBe(config.clientSecret);
    expect(request.body.get("code")).toBe("test-code");
    expect(request.body.get("redirect_uri")).toBe(redirectUri);
  });
});

describe("Google OAuth client configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadClient(clientId, clientSecret) {
    vi.stubEnv("ANTIGRAVITY_OAUTH_CLIENT_ID", clientId);
    vi.stubEnv("ANTIGRAVITY_OAUTH_CLIENT_SECRET", clientSecret);
    vi.resetModules();
    return (await import("../../open-sse/providers/shared.js")).ANTIGRAVITY_OAUTH_CLIENT;
  }

  it.each([undefined, "", "   "])("requires deployment credentials when configuration is empty (%s)", async (value) => {
    const client = await loadClient(value, value);
    expect(client).toEqual({ clientId: "", clientSecret: "" });
    expect(() => antigravity.buildAuthUrl({ ...antigravity.config, ...client }, "http://localhost:8007/callback", "state"))
      .toThrow("ANTIGRAVITY_OAUTH_CLIENT_ID、ANTIGRAVITY_OAUTH_CLIENT_SECRET");
  });

  it("supports a complete custom client pair and trims whitespace", async () => {
    expect(await loadClient(" custom-id ", " custom-secret ")).toEqual({
      clientId: "custom-id", clientSecret: "custom-secret",
    });
  });

  it.each([
    ["custom-id", "", "ANTIGRAVITY_OAUTH_CLIENT_SECRET"],
    ["", "custom-secret", "ANTIGRAVITY_OAUTH_CLIENT_ID"],
  ])("does not mix an incomplete custom client with default credentials", async (id, secret, missing) => {
    const client = await loadClient(id, secret);
    expect(client).toEqual({ clientId: id, clientSecret: secret });
    expect(() => antigravity.buildAuthUrl({ ...antigravity.config, ...client }, "http://localhost:8007/callback", "state"))
      .toThrow(missing);
  });

  it("wires the shared Antigravity client into the registry transport", async () => {
    const ag = (await import("../../open-sse/providers/registry/antigravity.js")).default;
    expect(ag.transport).toMatchObject(ANTIGRAVITY_OAUTH_CLIENT);
  });

  it("loads the Gemini client from environment variables and shares it across registries", async () => {
    expect(GOOGLE_OAUTH_CLIENT).toEqual({
      clientId: process.env.GEMINI_OAUTH_CLIENT_ID || "",
      clientSecret: process.env.GEMINI_OAUTH_CLIENT_SECRET || "",
    });
    const gemini = (await import("../../open-sse/providers/registry/gemini.js")).default;
    const geminiCli = (await import("../../open-sse/providers/registry/gemini-cli.js")).default;
    expect(gemini.transport).toMatchObject(GOOGLE_OAUTH_CLIENT);
    expect(geminiCli.transport).toMatchObject(GOOGLE_OAUTH_CLIENT);
  });

  it("does not embed Google OAuth credentials in shared configuration", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../../open-sse/providers/shared.js", import.meta.url), "utf8");
    expect(source).not.toMatch(/GOCSPX-[A-Za-z0-9_-]+/);
    expect(source).not.toMatch(/[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com/);
  });

  it("does not hardcode OAuth credential values in the dashboard config", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "../../src/lib/oauth/constants/oauth.js"), "utf8");
    expect(source).toContain('import { ANTIGRAVITY_OAUTH_CLIENT, GOOGLE_OAUTH_CLIENT } from "open-sse/providers/shared.js"');
    expect(source).toContain("...ANTIGRAVITY_OAUTH_CLIENT");
    expect(source).toContain("...GOOGLE_OAUTH_CLIENT");
    expect(source).toContain('PROVIDER_OAUTH["antigravity"]');
    expect(source).toContain('PROVIDER_OAUTH["gemini-cli"]');
    for (const name of ["GEMINI_CONFIG", "ANTIGRAVITY_CONFIG"]) {
      const block = source.match(new RegExp(`export const ${name} = \\{[\\s\\S]*?\\};`));
      expect(block).not.toBeNull();
      expect(block[0]).not.toMatch(/clientSecret:\s*["'][^"']+["']/);
    }
  });
});
