import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { getMouseById } = vi.hoisted(() => ({ getMouseById: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ getMouseById }));
const { POST } = await import("../../src/app/api/mouses/[id]/test/route.js");
const { registerTunnel, unregisterTunnel, deliverMouseResult, pendingTaskCount } = await import("../../src/lib/mouse/tunnel.js");
const mouseId = "diagnostic-node";
const frames = [];
const request = (springUrl = "https://spring.example") => new Request("http://spring.internal/api/mouses/diagnostic-node/test", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ springUrl }),
});
const params = { params: Promise.resolve({ id: mouseId }) };
beforeEach(() => {
  frames.length = 0;
  getMouseById.mockResolvedValue({ id: mouseId, disabledAt: null });
});
afterEach(() => { unregisterTunnel(mouseId); vi.useRealTimers(); vi.restoreAllMocks(); });
function connect(status = 405) {
  registerTunnel(mouseId, { send(event, data) {
    frames.push({ event, data });
    if (event === "task" && status !== null) {
      queueMicrotask(() => deliverMouseResult(data.taskId, { status, headers: {}, body: new Response("probe").body }));
    }
    return true;
  } });
}
describe("Mouse task round-trip diagnostic", () => {
  it("tests actual execution without provider credentials or account bindings", async () => {
    connect();
    const result = await POST(request("https://spring.example/ignored?token=discard"), params);
    expect(await result.json()).toMatchObject({ ok: true, providerTested: false, scope: "task_round_trip", upstreamStatus: 405 });
    expect(frames[0].data.request).toEqual({ method: "POST", url: "https://spring.example/api/version",
      headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(pendingTaskCount()).toBe(0);
  });
  it("does not claim success for an unexpected intercepted response", async () => {
    connect(200);
    const result = await POST(request(), params);
    expect(await result.json()).toMatchObject({ ok: false, upstreamStatus: 200 });
  });
  it("requires a live tunnel, not just a recent heartbeat", async () => {
    expect((await POST(request(), params)).status).toBe(409);
    expect(frames).toHaveLength(0);
  });
  it("refuses a disabled node", async () => {
    connect(); getMouseById.mockResolvedValue({ id: mouseId, disabledAt: "disabled" });
    expect((await POST(request(), params)).status).toBe(409);
    expect(frames).toHaveLength(0);
  });
  it.each(["file:///etc/passwd", "https://user:secret@spring.example"])("refuses an invalid probe address", async address => {
    connect();
    expect((await POST(request(address), params)).status).toBe(400);
    expect(frames).toHaveLength(0);
  });
  it("cancels and cleans up a silent node within ten seconds", async () => {
    vi.useFakeTimers(); connect(null);
    const work = POST(request(), params);
    await vi.advanceTimersByTimeAsync(10000);
    expect((await work).status).toBe(503);
    expect(frames.map(f => f.event)).toEqual(["task", "cancel"]);
    expect(pendingTaskCount()).toBe(0);
  });
});
