import { describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ credentials: { connectionId: "a", releaseRouteSlot: vi.fn() }, core: vi.fn() }));
vi.mock("@/sse/services/auth.js", () => ({ getProviderCredentials: vi.fn(async () => state.credentials) }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: async (_, credentials) => credentials, updateProviderCredentials: vi.fn() }));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: state.core }));
const { executeCapabilityProbe } = await import("@/lib/modelCapabilities/execute.js");
const { makeCapabilityProbe } = await import("@/lib/modelCapabilities/samples.js");
const identity = { providerId: "openai", modelId: "m", connectionId: "a" };
describe("probe dispatch preserves tested input", () => {
  it("rejects a lossy modality conversion before the upstream call", async () => {
    state.core.mockImplementationOnce(async (options) => {
      options.onProbeDispatch({ body: { messages: [{ role: "user", content: "image omitted" }] } });
    });
    await expect(executeCapabilityProbe(identity, await makeCapabilityProbe("vision"), { signal: new AbortController().signal, timeoutMs: 5000 })).rejects.toThrow("未能保留");
  });
  it("uses internal probe mode and drains a complete response", async () => {
    const probe = await makeCapabilityProbe("text");
    state.core.mockImplementationOnce(async (options) => {
      expect(options.capabilityProbe).toBe(true);
      expect(options.internalRequest).toBe(true);
      options.onProbeDispatch({ body: options.body });
      return { success: true, response: new Response(JSON.stringify({ choices: [{ message: { content: probe.expected[0] } }] })) };
    });
    const result = await executeCapabilityProbe(identity, probe, { signal: new AbortController().signal, timeoutMs: 5000 });
    expect(result.dispatched).toBe(true);
    expect(result.json.choices[0].message.content).toBe(probe.expected[0]);
  });
});
