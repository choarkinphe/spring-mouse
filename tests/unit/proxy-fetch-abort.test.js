import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let createBypassRequest;
let originalFetch;

beforeAll(async () => {
  originalFetch = globalThis.fetch;
  ({ createBypassRequest } = await import("../../open-sse/utils/proxyFetch.js"));
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("MITM DNS-bypass request cancellation", () => {
  it("aborts a raw TLS handshake when the caller disconnects", async () => {
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.resume();
      // Deliberately never complete TLS: this simulates a channel that accepts
      // TCP but never responds, which previously left the raw socket hanging.
    });
    const port = await listen(server);
    const abort = new AbortController();
    const startedAt = Date.now();

    const pending = createBypassRequest(
      new URL(`https://upstream.test:${port}/v1/chat/completions`),
      "127.0.0.1",
      { method: "POST", body: "{}", signal: abort.signal },
    );
    setTimeout(() => abort.abort("client disconnected"), 20);

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - startedAt).toBeLessThan(1000);

    await close(server);
  });
});
