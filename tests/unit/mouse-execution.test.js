import { describe, expect, it } from "vitest";
import { BaseExecutor } from "open-sse/executors/base.js";
import { registerTunnel, deliverMouseResult, unregisterTunnel } from "../../src/lib/mouse/tunnel.js";

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
