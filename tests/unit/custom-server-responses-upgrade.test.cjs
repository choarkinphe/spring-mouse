const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

// The wrapper is exercised through server.emit("upgrade") rather than a real
// socket: CI sandboxes may forbid listening, and the behaviour under test is
// exactly which handler the upgrade event reaches.
function harness() {
  const originalCreateServer = http.createServer;
  delete require.cache[require.resolve("../../custom-server.js")];
  require("../../custom-server.js");

  const calls = { next: 0 };
  const server = http.createServer((_req, res) => res.end("ok"));
  server.on("upgrade", (_req, socket) => {
    calls.next++;
    socket.end("HTTP/1.1 101 Switching Protocols\r\n\r\n");
  });
  return {
    calls,
    emitUpgrade(headers) {
      const written = [];
      const socket = { end: (chunk) => written.push(String(chunk)), destroy() {} };
      const req = { url: headers.url, headers };
      const handled = server.emit("upgrade", req, socket, Buffer.alloc(0));
      return { handled, written: written.join("") };
    },
    restore() {
      server.close();
      http.createServer = originalCreateServer;
    },
  };
}

test("rejects Responses WebSocket upgrades with 426 instead of closing the socket", () => {
  const h = harness();
  try {
    for (const url of ["/v1/responses", "/responses", "/codex/v1/responses", "/backend-api/codex/responses", "/v1/responses?stream=1"]) {
      const { handled, written } = h.emitUpgrade({ url, upgrade: "websocket" });
      assert.equal(handled, true, url);
      assert.match(written, /^HTTP\/1\.1 426 Upgrade Required\r\n/, url);
      assert.match(written, /\r\nContent-Type: text\/plain; charset=utf-8\r\n/i, url);
      assert.match(written, /\r\nUpgrade: HTTP\/1\.1\r\n/i, url);
      assert.match(written, /relays Responses over HTTP only/, url);
    }
    assert.equal(h.calls.next, 0);
  } finally {
    h.restore();
  }
});

test("leaves unrelated WebSocket upgrades to the next handler", () => {
  const h = harness();
  try {
    const { written } = h.emitUpgrade({ url: "/v1/realtime", upgrade: "websocket" });
    assert.match(written, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
    assert.equal(h.calls.next, 1);
  } finally {
    h.restore();
  }
});
