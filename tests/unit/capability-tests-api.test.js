import { describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ runs: vi.fn(), profiles: [] }));
vi.mock("@/lib/db/index.js", () => ({
  getProviderConnectionById: async (id) => id === "account" ? { id, provider: "openai", isActive: true } : null,
  getProviderConnections: async () => [{ id: "account", provider: "openai", isActive: true }],
  getProviderNodes: async () => [],
  getModelCapabilityTests: async () => state.profiles,
  deleteModelCapabilityTests: async () => 1,
}));
vi.mock("@/lib/modelCapabilityOverrides.js", () => ({ refreshModelCapabilityOverrides: async () => {} }));
vi.mock("@/lib/modelCapabilities/runner.js", () => ({ normalizeProbeOptions: () => ({ tests: ["text"] }), runCapabilityTests: state.runs }));
const { GET, POST, DELETE } = await import("@/app/api/models/capability-tests/route.js");
const request = (body) => new Request("http://localhost/api/models/capability-tests", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
describe("capability test management API", () => {
  it("rejects a connection belonging to a different channel before executing", async () => {
    const res = await POST(request({ providerId: "deepseek", modelId: "model", connectionId: "account" }));
    expect(res.status).toBe(400);
    expect(state.runs).not.toHaveBeenCalled();
  });
  it("streams typed progress and reports with no-store", async () => {
    state.runs.mockImplementationOnce(async (_, __, ___, { emit }) => { emit({ type: "started" }); emit({ type: "complete", report: { status: "completed" } }); });
    const res = await POST(request({ providerId: "openai", modelId: "model", connectionId: "account" }));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect((await res.text()).trim().split("\n").map(JSON.parse).map(e => e.type)).toEqual(["started", "complete"]);
  });
  it("propagates stream cancellation to the runner", async () => {
    let cancelled;
    state.runs.mockImplementationOnce(async (_, __, ___, { signal, emit }) => {
      emit({ type: "started" });
      await new Promise((resolve) => signal.addEventListener("abort", () => { cancelled = signal.aborted; resolve(); }, { once: true }));
    });
    const res = await POST(request({ providerId: "openai", modelId: "model", connectionId: "account" }));
    const reader = res.body.getReader();
    await reader.read(); await reader.cancel();
    expect(cancelled).toBe(true);
  });
  it("requires scoped model and account for clearing reports", async () => {
    const res = await DELETE(request({ providerId: "openai", connectionId: "account" }));
    expect(res.status).toBe(400);
    const data = await GET(new Request("http://localhost/api/models/capability-tests?providerId=openai&modelId=model"));
    expect(data.status).toBe(200);
    expect((await data.json()).connections[0]).not.toHaveProperty("apiKey");
  });
});
