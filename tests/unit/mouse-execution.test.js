import { describe, expect, it } from "vitest";
import { BaseExecutor } from "open-sse/executors/base.js";

class TestExecutor extends BaseExecutor {
  constructor() {
    super("test-provider", { baseUrl: "https://provider.example/chat" });
  }

  transformRequest(model, body) {
    return { ...body, upstreamModel: model };
  }
}

describe("Mouse-backed BaseExecutor transport", () => {
  it("forwards the final provider request to the callback URL", async () => {
    const providerResponse = new Response("upstream", { status: 200 });
    const originalFetch = global.fetch;
    let task;
    global.fetch = async (url, init) => {
      task = { url, init };
      return providerResponse;
    };

    try {
      const executor = new TestExecutor();
      const result = await executor.execute({
        model: "test-model",
        body: { prompt: "hello" },
        stream: false,
        signal: undefined,
        credentials: {
          apiKey: "provider-secret",
          mouseExecution: {
            mouseId: "mouse-1",
            callbackUrl: "http://127.0.0.1:9101/",
            executionToken: "msx_test",
          },
        },
      });

      expect(result.response).toBe(providerResponse);
      expect(result.url).toBe("https://provider.example/chat");
      expect(result.transformedBody).toEqual({ prompt: "hello", upstreamModel: "test-model" });
      expect(task.url).toBe("http://127.0.0.1:9101/v1/execute");
      expect(task.init.headers.Authorization).toBe("Bearer msx_test");
      const body = JSON.parse(task.init.body);
      expect(body.taskId).toBeTruthy();
      expect(body.request.url).toBe("https://provider.example/chat");
      expect(body.request.headers.Authorization).toBe("Bearer provider-secret");
      expect(JSON.parse(body.request.body).upstreamModel).toBe("test-model");
    } finally {
      global.fetch = originalFetch;
    }
  });
});
