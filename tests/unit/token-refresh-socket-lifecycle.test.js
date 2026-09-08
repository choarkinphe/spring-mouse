import http from "node:http";
import { expect, it } from "vitest";
import { dedupRefresh } from "../../open-sse/services/tokenRefresh/dedup.js";

// Real local HTTP transport: no production endpoint, key or database.
it.each(["headers", "body"])("aborts the actual refresh socket during a %s stall", async (phase) => {
  let active = 0;
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    active++;
    res.on("close", () => { active--; });
    if (req.url === "/healthy") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ accessToken: "recovered" }));
      return;
    }
    if (phase === "body") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"access_token":');
    }
    // Deliberately never finish the response.
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const url = `http://127.0.0.1:${server.address().port}/token`;
    const pending = Promise.all(Array.from({ length: 12 }, (_, index) =>
      dedupRefresh("local-test", `${phase}-${index}`, async (signal) => {
        const response = await fetch(url, { method: "POST", signal });
        return response.json();
      }, null, { timeoutMs: 500 }),
    ));
    await expect.poll(() => active).toBe(12);
    expect(await pending).toEqual(Array(12).fill(null));
    await expect.poll(() => active).toBe(0);
    // A subsequent operation can run; no rejected/hanging refresh lock remains.
    expect(await dedupRefresh("local-test", `${phase}-0`, async (signal) => {
      const response = await fetch(url.replace("/token", "/healthy"), { signal });
      return response.json();
    })).toEqual({ accessToken: "recovered" });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});
