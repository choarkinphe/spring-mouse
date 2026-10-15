import { afterEach, describe, expect, it, vi } from "vitest";
import { BaseExecutor } from "open-sse/executors/base.js";
import { registerTunnel, deliverMouseResult, unregisterTunnel, markMouseTaskStarted, pendingTaskCount } from "../../src/lib/mouse/tunnel.js";

class TestExecutor extends BaseExecutor {
  constructor() {
    super("test-provider", { baseUrl: "https://provider.example/chat" });
  }

  transformRequest(model, body) {
    return { ...body, upstreamModel: model };
  }
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was never met");
}

describe("Mouse-backed BaseExecutor transport", () => {
  it("hands the provider request to the node and returns the replayed response", async () => {
    const frames = [];
    const mouseId = "executor-mouse";
    registerTunnel(mouseId, {
      send(event, data) {
        frames.push({ event, data });
        return true;
      },
    });

    try {
      const executor = new TestExecutor();
      const pending = executor.execute({
        model: "test-model",
        body: { prompt: "hello" },
        stream: false,
        signal: undefined,
        credentials: {
          apiKey: "provider-secret",
          mouseExecution: { mouseId },
        },
      });

      await waitFor(() => frames.length > 0);
      const task = frames[0].data;
      // The provider request is built in full on the Spring side — the node only
      // forwards it — so everything about the call is already decided here.
      expect(task.request.url).toBe("https://provider.example/chat");
      expect(task.request.headers.Authorization).toBe("Bearer provider-secret");
      expect(JSON.parse(task.request.body)).toEqual({ prompt: "hello", upstreamModel: "test-model" });

      deliverMouseResult(task.taskId, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: new Response("upstream-body").body,
      });

      const result = await pending;
      expect(result.url).toBe("https://provider.example/chat");
      expect(result.response.status).toBe(200);
      expect(result.response.headers.get("content-type")).toBe("text/event-stream");
      await expect(result.response.text()).resolves.toBe("upstream-body");
    } finally {
      unregisterTunnel(mouseId);
    }
  });

  it("surfaces an offline node as a failure so the caller can fall back", async () => {
    const executor = new TestExecutor();
    await expect(executor.execute({
      model: "test-model",
      body: { prompt: "hello" },
      stream: false,
      signal: undefined,
      credentials: {
        apiKey: "provider-secret",
        mouseExecution: { mouseId: "node-that-never-connected" },
      },
    })).rejects.toMatchObject({ code: "offline" });
  });

  it("refuses to run when the credential carries no node id", async () => {
    const executor = new TestExecutor();
    await expect(executor.execute({
      model: "test-model",
      body: { prompt: "hello" },
      stream: false,
      signal: undefined,
      credentials: { apiKey: "provider-secret", mouseExecution: {} },
    })).rejects.toThrow(/not ready for task execution/);
  });
});

describe("Mouse waiting deadline", () => {
  const mouseId = "deadline-mouse";
  const args = () => ({ model: "test-model", body: {}, stream: true,
    credentials: { apiKey: "synthetic", mouseExecution: { mouseId } } });
  const frames = [];
  function connect() {
    frames.length = 0;
    registerTunnel(mouseId, { send(event, data) { frames.push({ event, data }); return true; } });
  }
  afterEach(() => { unregisterTunnel(mouseId); vi.useRealTimers(); vi.restoreAllMocks(); });

  it("rejects an expired request without transforming or dispatching it", async () => {
    connect();
    const executor = new TestExecutor();
    const transform = vi.spyOn(executor, "transformRequest");
    await expect(executor.execute({ ...args(), overloadDeadline: Date.now() - 1 }))
      .rejects.toMatchObject({ name: "TimeoutError" });
    expect(transform).not.toHaveBeenCalled();
    expect(frames).toHaveLength(0);
  });

  it.each([false, true])("cancels remote work at the same deadline (acknowledged=%s)", async acknowledged => {
    vi.useFakeTimers(); connect();
    const work = new TestExecutor().execute({ ...args(), overloadDeadline: Date.now() + 1000 });
    const assertion = expect(work).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(800);
    const taskId = frames[0].data.taskId;
    if (acknowledged) expect(markMouseTaskStarted(taskId)).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    await assertion;
    expect(frames.map(f => f.event)).toEqual(["task", "cancel"]);
    expect(frames[1].data.reason).toBe("request_deadline");
    expect(pendingTaskCount()).toBe(0);
    expect(deliverMouseResult(taskId, { status: 200, body: "late" })).toBe(false);
  });

  it("keeps an accepted stream alive past the header waiting deadline", async () => {
    vi.useFakeTimers(); connect();
    let controller;
    const body = new ReadableStream({ start(c) { controller = c; } });
    const work = new TestExecutor().execute({ ...args(), overloadDeadline: Date.now() + 1000 });
    await vi.advanceTimersByTimeAsync(20);
    deliverMouseResult(frames[0].data.taskId, { status: 200, body, headers: {} });
    const result = await work;
    await vi.advanceTimersByTimeAsync(400000);
    controller.enqueue(new TextEncoder().encode("complete long stream")); controller.close();
    expect(await result.response.text()).toBe("complete long stream");
    expect(frames.map(f => f.event)).toEqual(["task"]);
    expect(result.timing.upstreamHeadersMs).toBe(20);
  });

  it("preserves client cancellation instead of reporting a timeout", async () => {
    vi.useFakeTimers(); connect();
    const client = new AbortController();
    const work = new TestExecutor().execute({ ...args(), signal: client.signal, overloadDeadline: Date.now() + 1000 });
    const assertion = expect(work).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(20);
    client.abort(); await assertion;
    expect(frames.map(f => f.event)).toEqual(["task", "cancel"]);
    expect(pendingTaskCount()).toBe(0);
  });
});
