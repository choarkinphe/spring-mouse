import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dataDir;
let mousesRepo;
let tunnel;
let tunnelRoute;
let resultRoute;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "spring-mouse-tunnel-"));
  process.env.DATA_DIR = dataDir;
  const db = await import("../../src/lib/db/driver.js");
  mousesRepo = await import("../../src/lib/db/repos/mousesRepo.js");
  tunnel = await import("../../src/lib/mouse/tunnel.js");
  tunnelRoute = await import("../../src/app/api/mouses/tunnel/route.js");
  resultRoute = await import("../../src/app/api/mouses/tunnel/result/route.js");
  await db.getAdapter();
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function collectorHandle() {
  const frames = [];
  return {
    frames,
    handle: {
      send(event, data) {
        frames.push({ event, data });
        return true;
      },
    },
  };
}

// SSE frames are separated by a blank line, and one read can carry several of
// them, so the reader keeps a buffer instead of assuming one frame per chunk.
async function nextFrame(reader, decoder, state, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const index = state.buffer.indexOf("\n\n");
    if (index !== -1) {
      const frame = state.buffer.slice(0, index);
      state.buffer = state.buffer.slice(index + 2);
      return frame;
    }
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`stream ended before a frame arrived (buffer=${state.buffer})`);
    state.buffer += decoder.decode(chunk.value, { stream: true });
  }
  throw new Error(`no complete frame within ${timeoutMs}ms (buffer=${state.buffer})`);
}

describe("mouse nodes are reachable without an address", () => {
  it("creates a node that carries no callback URL or execution token", async () => {
    const created = await mousesRepo.createMouse({ name: "tokyo-edge" });

    expect(created.token).toMatch(/^mst_/);
    expect(created.mouse.status).toBe("unregistered");
    expect(created.mouse.clientId).toMatch(/^tokyo-edge-/);
    // The whole point of the reverse connection: nothing about where the node
    // lives is stored, so there is nothing for an operator to fill in wrongly.
    expect(created.mouse).not.toHaveProperty("callbackUrl");
    expect(created.mouse).not.toHaveProperty("executionTokenConfigured");

    const found = await mousesRepo.getMouseByAccessToken(created.token);
    expect(found.id).toBe(created.mouse.id);
    expect(await mousesRepo.getMouseByAccessToken("mst_not_a_real_token")).toBeNull();
  });

  it("returns only the node id as execution details", async () => {
    const { mouse } = await mousesRepo.createMouse({ name: "details-node" });
    expect(await mousesRepo.getMouseExecutionDetails(mouse.id)).toEqual({ mouseId: mouse.id });
    expect(await mousesRepo.getMouseExecutionDetails("missing")).toBeNull();
  });
});

describe("tunnel registry", () => {
  it("pushes a task down the tunnel and resolves with what the node sends back", async () => {
    const { mouse } = await mousesRepo.createMouse({ name: "dispatch-node" });
    const { frames, handle } = collectorHandle();
    tunnel.registerTunnel(mouse.id, handle);
    expect(tunnel.isTunnelConnected(mouse.id)).toBe(true);

    const pending = tunnel.dispatchMouseTask(mouse.id, {
      taskId: "task-1",
      request: { method: "POST", url: "https://provider.example/v1/chat", body: "{}" },
    });

    expect(frames.map((frame) => frame.event)).toEqual(["task"]);
    expect(frames[0].data.taskId).toBe("task-1");
    expect(frames[0].data.request.url).toBe("https://provider.example/v1/chat");

    expect(tunnel.deliverMouseResult("task-1", { status: 429, headers: { "retry-after": "3" }, body: "stream" })).toBe(true);
    await expect(pending).resolves.toEqual({ status: 429, headers: { "retry-after": "3" }, body: "stream" });
    expect(tunnel.pendingTaskCount()).toBe(0);

    tunnel.disconnectTunnel(mouse.id);
    expect(tunnel.isTunnelConnected(mouse.id)).toBe(false);
  });

  it("rejects immediately when the node holds no tunnel", async () => {
    await expect(tunnel.dispatchMouseTask("node-with-no-tunnel", { taskId: "t" }))
      .rejects.toMatchObject({ code: "offline" });
  });

  it("ignores a result for a task nobody is waiting on", async () => {
    expect(tunnel.deliverMouseResult("unknown-task", { status: 200, headers: {}, body: null })).toBe(false);
  });

  it("fails in-flight work when the tunnel drops", async () => {
    const { mouse } = await mousesRepo.createMouse({ name: "drop-node" });
    const { handle } = collectorHandle();
    tunnel.registerTunnel(mouse.id, handle);

    const pending = tunnel.dispatchMouseTask(mouse.id, { taskId: "task-drop" });
    tunnel.unregisterTunnel(mouse.id, handle);

    await expect(pending).rejects.toMatchObject({ code: "offline" });
    expect(tunnel.pendingTaskCount()).toBe(0);
  });

  it("leaves a reconnected tunnel alone when the dead stream reports in late", async () => {
    const { mouse } = await mousesRepo.createMouse({ name: "reconnect-node" });
    const first = collectorHandle();
    const second = collectorHandle();
    tunnel.registerTunnel(mouse.id, first.handle);
    tunnel.registerTunnel(mouse.id, second.handle);

    // The old stream only notices its socket died after the replacement is up.
    expect(tunnel.unregisterTunnel(mouse.id, first.handle)).toBe(false);
    expect(tunnel.isTunnelConnected(mouse.id)).toBe(true);
    expect(tunnel.unregisterTunnel(mouse.id, second.handle)).toBe(true);
  });

  it("times out when the node never starts the task", async () => {
    const { mouse } = await mousesRepo.createMouse({ name: "slow-node" });
    const { frames, handle } = collectorHandle();
    tunnel.registerTunnel(mouse.id, handle);

    await expect(tunnel.dispatchMouseTask(mouse.id, { taskId: "task-slow", ackTimeoutMs: 20 }))
      .rejects.toMatchObject({ code: "timeout" });
    // A timeout is told to the node so it can stop a request nobody wants.
    expect(frames.map((frame) => frame.event)).toContain("cancel");
  });

  it("tells the node to cancel when the caller goes away", async () => {
    const { mouse } = await mousesRepo.createMouse({ name: "abort-node" });
    const { frames, handle } = collectorHandle();
    tunnel.registerTunnel(mouse.id, handle);

    const controller = new AbortController();
    const pending = tunnel.dispatchMouseTask(mouse.id, {
      taskId: "task-abort",
      signal: controller.signal,
      ackTimeoutMs: 5000,
    });
    controller.abort(new Error("client disconnected"));

    await expect(pending).rejects.toMatchObject({ code: "aborted", name: "AbortError" });
    expect(frames.map((frame) => frame.event)).toContain("cancel");
  });
});

describe("tunnel routes", () => {
  it("streams a ready frame, pushes the task, and accepts the replayed response", async () => {
    const { mouse, token } = await mousesRepo.createMouse({ name: "route-node" });

    const response = await tunnelRoute.GET(new Request("http://localhost/api/mouses/tunnel?version=2.0.0", {
      headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(tunnel.isTunnelConnected(mouse.id)).toBe(true);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state = { buffer: "" };

    const ready = await nextFrame(reader, decoder, state);
    expect(ready).toContain("event: ready");
    expect(ready).toContain(mouse.clientId);

    const pending = tunnel.dispatchMouseTask(mouse.id, {
      taskId: "route-task",
      request: { method: "POST", url: "https://provider.example/v1/chat", headers: {}, body: "{}" },
    });
    const taskFrame = await nextFrame(reader, decoder, state);
    expect(taskFrame).toContain("event: task");
    expect(taskFrame).toContain("route-task");

    const upstreamHeaders = Buffer.from(JSON.stringify({ "content-type": "application/json" }), "utf8").toString("base64");
    // Read the body before awaiting the POST: the handler stays alive until the
    // upload has been handed over, and that only finishes once a consumer reads
    // it. Awaiting the POST first would deadlock against the backpressure.
    const relayedPromise = resultRoute.POST(new Request("http://localhost/api/mouses/tunnel/result", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "x-mouse-task-id": "route-task",
        "x-upstream-status": "201",
        "x-upstream-headers": upstreamHeaders,
      },
      body: "hello-upstream",
    }));

    const delivered = await pending;
    expect(delivered.status).toBe(201);
    expect(delivered.headers).toEqual({ "content-type": "application/json" });
    await expect(new Response(delivered.body).text()).resolves.toBe("hello-upstream");

    expect((await relayedPromise).status).toBe(200);

    await reader.cancel();
    expect(tunnel.isTunnelConnected(mouse.id)).toBe(false);
  });

  it("refuses a tunnel without a valid token", async () => {
    const anonymous = await tunnelRoute.GET(new Request("http://localhost/api/mouses/tunnel"));
    expect(anonymous.status).toBe(401);

    const forged = await tunnelRoute.GET(new Request("http://localhost/api/mouses/tunnel", {
      headers: { Authorization: "Bearer mst_forged" },
    }));
    expect(forged.status).toBe(401);
  });

  it("refuses a result for an unknown task", async () => {
    const { token } = await mousesRepo.createMouse({ name: "stale-result-node" });
    const response = await resultRoute.POST(new Request("http://localhost/api/mouses/tunnel/result", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "x-mouse-task-id": "nobody-waits", "x-upstream-status": "200" },
      body: "orphan",
    }));
    expect(response.status).toBe(404);
  });

  it("refuses a result that carries no task id", async () => {
    const { token } = await mousesRepo.createMouse({ name: "no-task-id-node" });
    const response = await resultRoute.POST(new Request("http://localhost/api/mouses/tunnel/result", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: "orphan",
    }));
    expect(response.status).toBe(400);
  });
});
