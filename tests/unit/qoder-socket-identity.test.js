import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readQoderSocketIdentity } from "../../src/lib/services/qoderNativeIdentity.js";

const resources = [];
afterEach(async () => {
  for (const { server, dir } of resources.splice(0)) {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
async function fixture(reply) {
  const dir = await mkdtemp(join(tmpdir(), "qd-socket-"));
  const socket = join(dir, "identity.sock");
  const received = [];
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    received.push({ method: req.method, path: req.url, body: JSON.parse(body) });
    res.end(JSON.stringify({ identity: reply }));
  });
  await new Promise(resolve => server.listen(socket, resolve));
  resources.push({ dir, server });
  return { socket, received };
}
describe("private Qoder native identity transport", () => {
  it("sends only region, never credentials, and validates complete native identity", async () => {
    const f = await fixture({ machineToken: "fixture-token", machineType: "fixture-type", machineCode: "fixture-code", machineId: "stable-id" });
    expect(await readQoderSocketIdentity("global", { socket: f.socket })).toEqual({ "Cosy-MachineToken": "fixture-token", "Cosy-MachineType": "fixture-type", "Cosy-MachineCode": "fixture-code", "Cosy-MachineId": "stable-id" });
    expect(f.received).toEqual([{ method: "POST", path: "/identity", body: { region: "global" } }]);
  });
  it("rejects invalid region, arbitrary URL and header injection", async () => {
    expect(() => readQoderSocketIdentity("invalid", { socket: "/tmp/native.sock" })).toThrow();
    expect(() => readQoderSocketIdentity("global", { socket: "https://untrusted.test" })).toThrow();
    const f = await fixture({ machineToken: "bad\r\nheader", machineType: "t", machineCode: "c", machineId: "m" });
    await expect(readQoderSocketIdentity("global", { socket: f.socket })).rejects.toThrow("unavailable");
  });
});
