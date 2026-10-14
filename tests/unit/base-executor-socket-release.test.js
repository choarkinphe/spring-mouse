import { createServer } from "node:http";
import { Agent, fetch } from "undici";
import { describe, expect, it, vi } from "vitest";

const network = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => network.fetch(...args) }));
const { BaseExecutor } = await import("../../open-sse/executors/base.js");

describe("retry socket ownership", () => {
  it("retries through a one-connection pool when the discarded 502 body never ends", async () => {
    let received = 0;
    let firstClosed = false;
    const server = createServer((req, res) => {
      req.resume(); received++;
      if (received === 1) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.write("upstream unavailable");
        res.on("close", () => { firstClosed = true; });
      } else res.end("recovered");
    });
    const agent = new Agent({ connections: 1, pipelining: 1 });
    try {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      network.fetch.mockImplementation((url, options) => fetch(url, { ...options, dispatcher: agent }));
      const executor = new BaseExecutor("fixture", {
        baseUrl: `http://127.0.0.1:${server.address().port}/chat`,
        timeoutMs: 1000, retry: { 502: { attempts: 1, delayMs: 0 } },
      });
      const result = await executor.execute({ model: "m", body: {}, stream: true, credentials: {} });
      expect(await result.response.text()).toBe("recovered");
      expect(received).toBe(2);
      await vi.waitFor(() => expect(firstClosed).toBe(true));
    } finally {
      await agent.destroy();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
});
