// Guards the shared OAuth configuration: credentials come from the deployment
// environment and provider registries do not duplicate them.
import { describe, it, expect } from "vitest";
import { ANTIGRAVITY_OAUTH_CLIENT, GOOGLE_OAUTH_CLIENT } from "../../open-sse/providers/shared.js";

describe("Google OAuth client configuration", () => {
  it("loads the Antigravity client from environment variables", () => {
    expect(ANTIGRAVITY_OAUTH_CLIENT).toEqual({
      clientId: process.env.ANTIGRAVITY_OAUTH_CLIENT_ID || "",
      clientSecret: process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET || "",
    });
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
    expect(source).not.toMatch(/clientSecret:\s*["'][^"']+["']/);
  });
});
