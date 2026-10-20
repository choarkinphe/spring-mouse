import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/sse/services/auth.js", () => ({ getProviderCredentials: vi.fn(async () => ({ connectionId: "go-connection" })) }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: vi.fn(async (_provider, credentials) => credentials), updateProviderCredentials: vi.fn() }));
vi.mock("@/sse/services/routeLease.js", () => ({ withRouteLease: vi.fn(async (_release, _signal, run) => run()) }));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: vi.fn(async () => ({ success: true, response: Response.json({ choices: [] }) })) }));

import { executeCapabilityProbe } from "../../src/lib/modelCapabilities/execute.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";

afterEach(() => vi.clearAllMocks());

describe("OpenCode Go capability probe session", () => {
  it("creates a separate probe conversation and exposes it to chatCore", async () => {
    const identity = { providerId: "opencode-go", modelId: "glm-5.2", connectionId: "go-connection" };
    const probe = { body: { messages: [{ role: "user", content: "hi" }] }, sourceFormat: "openai" };
    const options = { signal: new AbortController().signal, timeoutMs: 1000 };
    await executeCapabilityProbe(identity, probe, options);
    await executeCapabilityProbe(identity, probe, options);
    const calls = handleChatCore.mock.calls.map(([args]) => args);
    const sessions = calls.map((args) => args.clientRawRequest?.headers?.["x-opencode-session"]);
    expect(sessions.every((value) => /^spring-mouse-capability-test-[0-9a-f-]{36}$/.test(value))).toBe(true);
    expect(new Set(sessions).size).toBe(2);
  });

  it("leaves unrelated providers' request context unchanged", async () => {
    await executeCapabilityProbe(
      { providerId: "openai", modelId: "fixture-model", connectionId: "connection" },
      { body: { messages: [{ role: "user", content: "hi" }] }, sourceFormat: "openai" },
      { signal: new AbortController().signal, timeoutMs: 1000 },
    );
    expect(handleChatCore.mock.calls[0][0].clientRawRequest).toBeUndefined();
  });
});
