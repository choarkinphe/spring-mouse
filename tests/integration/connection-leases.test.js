// Opt-in, isolated real Redis. SM_REDIS_INTEGRATION=1 npm --prefix tests test -- integration/connection-leases.test.js
import { describe, it, expect, vi } from "vitest";
import { createClient } from "redis";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
describe.skipIf(process.env.SM_REDIS_INTEGRATION !== "1")("real Redis account leases", () => {
  it("atomically balances 100 requests, renews live leases, removes stale leases and fails open on timeout", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "sm-lease-redis-"));
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1"); await once(probe, "listening");
    const port = probe.address().port; await new Promise((r) => probe.close(r));
    let redis, admin, slots, routing; const leases = [];
    try {
      redis = spawn("redis-server", ["--bind", "127.0.0.1", "--port", String(port), "--save", "", "--appendonly", "no", "--dir", temp]);
      await new Promise((resolve, reject) => {
        let output = "";
        const timer = setTimeout(() => reject(new Error(`Redis startup timeout ${output}`)), 5000);
        redis.once("error", (e) => { clearTimeout(timer); reject(e); });
        redis.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Redis exited ${code}`)); });
        redis.stdout.on("data", (b) => { output += b; if (output.includes("Ready to accept connections")) { clearTimeout(timer); resolve(); } });
        redis.stderr.on("data", (b) => { output += b; });
      });
      vi.stubEnv("SPRING_MOUSE_REDIS_URL", `redis://127.0.0.1:${port}`);
      vi.stubEnv("SPRING_MOUSE_CONNECTION_SLOT_TTL_SECONDS", "3");
      vi.stubEnv("SPRING_MOUSE_ROUTING_REDIS_TIMEOUT_MS", "200");
      slots = await import("../../src/lib/redis/connectionSlots.js");
      routing = await import("../../src/lib/redis/routingClient.js");
      admin = createClient({ url: process.env.SPRING_MOUSE_REDIS_URL }); admin.on("error", () => {}); await admin.connect();
      const key = (id) => `spring-mouse:routing:{routing}:slots:v3:${id}`;
      const candidates = Array.from({ length: 8 }, (_, i) => ({ id: `account-${i}`, limit: 8 }));
      leases.push(...await Promise.all(Array.from({ length: 100 }, () => slots.reserveConnectionSlot(candidates))));
      expect(slots.getLocalSlotStatus()).toEqual({ active: 100, redis: 100, queued: 0 });
      const counts = await Promise.all(candidates.map((c) => admin.zCard(key(c.id))));
      expect(counts.reduce((a, b) => a + b, 0)).toBe(100);
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
      // A real 4.2s hold exceeds the configured 3s lease; the process heartbeat must extend it.
      await sleep(4200);
      const liveCounts = await Promise.all(candidates.map((c) => admin.zCount(key(c.id), Date.now(), "+inf")));
      expect(liveCounts.reduce((a, b) => a + b, 0)).toBe(100);
      await Promise.all(leases.map((l) => l.release()));
      expect((await Promise.all(candidates.map((c) => admin.zCard(key(c.id))))).every((n) => n === 0)).toBe(true);
      const old = await slots.reserveConnectionSlot([{ id: "reused", limit: 1 }]); leases.push(old);
      const [oldToken] = await admin.zRange(key("reused"), 0, -1);
      await old.release();
      const newer = await slots.reserveConnectionSlot([{ id: "reused", limit: 1 }]); leases.push(newer);
      await old.release(); expect(await admin.zCard(key("reused"))).toBe(1);
      await admin.eval(slots.RENEW_SCRIPT, { keys: [key("reused")], arguments: ["3000", oldToken] });
      expect(await admin.zCard(key("reused"))).toBe(1); // XX must not resurrect the old token.
      await newer.release();
      // Expired crashed-worker token alongside an unexpired token: reclaim independently of key TTL.
      await admin.zAdd(key("stale"), [{ score: Date.now() - 1000, value: "crashed" }, { score: Date.now() + 10000, value: "live" }]);
      const stale = await slots.reserveConnectionSlot([{ id: "stale", limit: 2 }]); leases.push(stale);
      expect(await admin.zScore(key("stale"), "crashed")).toBeNull(); expect(await admin.zCard(key("stale"))).toBe(2);
      await stale.release(); await admin.del(key("stale"));
      // Hard provider gate (HARD_RESERVE_SCRIPT): provider-wide cap, per-account cap
      // and a real lease TTL. A missing lease_ms argument once shifted the whole
      // ARGV layout, so every request on a provider-capped channel was rejected.
      const providerKey = "spring-mouse:routing:{routing}:provider:v1:probe";
      const hardCandidates = [{ id: "h0", limit: 1 }, { id: "h1", limit: 8 }];
      const hardOptions = { providerId: "probe", providerLimit: 4, weight: 1, queueTimeoutMs: 700, maxQueueSize: 10 };
      const first = await slots.reserveConnectionSlot(hardCandidates, hardOptions); leases.push(first);
      expect(first.connectionId).toBe("h0");
      expect(Number(await admin.sendCommand(["PTTL", providerKey]))).toBeGreaterThan(3000);
      // h0 sits at its account limit of 1, so the next request must fall through to h1.
      const second = await slots.reserveConnectionSlot(hardCandidates, hardOptions); leases.push(second);
      expect(second.connectionId).toBe("h1");
      expect(await admin.zCard(providerKey)).toBe(2);
      await first.release(); await second.release();
      expect(await admin.zCard(providerKey)).toBe(0);
      await admin.del(key("h0"), key("h1"), providerKey);
      // Pause ONLY our temporary Redis. Concurrent callers must return rather than wait for it.
      await admin.sendCommand(["CLIENT", "PAUSE", "1000", "ALL"]);
      const start = performance.now();
      const offline = await Promise.all(Array.from({ length: 20 }, () => slots.reserveConnectionSlot(candidates)));
      leases.push(...offline);
      expect(performance.now() - start).toBeLessThan(800);
      expect(slots.getLocalSlotStatus()).toEqual({ active: 20, redis: 0, queued: 0 });
      await Promise.all(offline.map((l) => l.release()));
      expect(slots.getLocalSlotStatus().active).toBe(0);
      await sleep(1100);
    } finally {
      await Promise.all(leases.map((l) => l.release()));
      routing?.closeRoutingRedis();
      if (admin?.isOpen) admin.destroy();
      if (redis && redis.exitCode === null) { const exit = once(redis, "exit"); redis.kill("SIGTERM"); await exit; }
      vi.unstubAllEnvs();
    }
  }, 20000);
});
