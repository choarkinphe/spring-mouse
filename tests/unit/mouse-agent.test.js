import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { MouseAgent } from "../../mouse/agent.mjs";

const cleanup = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) await fn(); });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanup.push(() => { server.closeAllConnections(); return new Promise(r => server.close(r)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const agent = new MouseAgent({ springUrl: url, token: "synthetic-test-token" });
  cleanup.push(() => agent.stop());
  return { agent, task: { taskId: "fixture-task", request: { url: `${url}/upstream`, method: "POST", body: "{}", headers: {} } } };
}

describe("Mouse agent over real HTTP", () => {
  it("relays the first SSE chunk before the upstream ends", async () => {
    const first = deferred(); const finish = deferred(); let ended = false; let uploaded = "";
    const { agent, task } = await fixture(async (req, res) => {
      req.resume();
      if (req.url === "/upstream") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"delta":"first"}\n\n');
        await finish.promise; ended = true; res.end("data: [DONE]\n\n");
      } else if (req.headers["x-mouse-phase"] === "started") res.end("{}");
      else {
        req.on("data", c => { uploaded += c; first.resolve(); });
        req.on("end", () => res.end());
      }
    });
    const work = agent.runTask(task);
    await first.promise;
    expect(ended).toBe(false);
    expect(uploaded).toContain("first");
    finish.resolve(); await work;
    expect(uploaded).toContain("[DONE]");
    expect(agent.activeTasks.size).toBe(0);
  });

  it.each([401, 403, 404, 500])("does not call the provider after handshake HTTP %s", async status => {
    let providers = 0;
    const { agent, task } = await fixture((req, res) => {
      req.resume();
      if (req.url === "/upstream") providers++;
      res.statusCode = req.headers["x-mouse-phase"] === "started" ? status : 200;
      res.end("{}");
    });
    await agent.runTask(task);
    expect(providers).toBe(0); expect(agent.activeTasks.size).toBe(0);
  });

  it("cancels a stalled handshake and releases the task", async () => {
    const started = deferred(); let providers = 0;
    const { agent, task } = await fixture((req, res) => {
      req.resume();
      if (req.headers["x-mouse-phase"] === "started") { started.resolve(); return; }
      if (req.url === "/upstream") providers++;
      res.end("{}");
    });
    const work = agent.runTask(task); await started.promise;
    agent.activeTasks.get(task.taskId).abort(new Error("test cancellation"));
    await work;
    expect(providers).toBe(0); expect(agent.activeTasks.size).toBe(0);
  });

  it("closes the upstream when Spring rejects its live result upload", async () => {
    const closed = deferred();
    const { agent, task } = await fixture((req, res) => {
      req.resume();
      if (req.url === "/upstream") {
        res.once("close", () => closed.resolve());
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: first\n\n");
      } else {
        res.statusCode = req.headers["x-mouse-phase"] === "started" ? 200 : 404;
        res.end("{}");
      }
    });
    await agent.runTask(task);
    await closed.promise;
    expect(agent.activeTasks.size).toBe(0);
  });

  it("bounds a stalled handshake and failure report", async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const deadlines = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(50));
    let providers = 0;
    const { agent, task } = await fixture((req) => { req.resume(); if (req.url === "/upstream") providers++; });
    await agent.runTask(task);
    expect(providers).toBe(0); expect(agent.activeTasks.size).toBe(0);
    expect(deadlines).toHaveBeenCalledWith(10000);
  });
});
