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
  it("enforces weighted caps under load, renews every member, ages waiters, and bounds Redis outages", async () => {
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
      let peak = 0;
      await Promise.all(Array.from({ length: 100 }, async () => {
        const lease = await slots.reserveConnectionSlot(candidates, {maxQueueSize:200}); leases.push(lease);
        peak = Math.max(peak, slots.getLocalSlotStatus().active);
        await sleep(20);
        await lease.release();
      }));
      expect(peak).toBeGreaterThan(1); expect(peak).toBeLessThanOrEqual(64);
      expect(slots.getLocalSlotStatus()).toEqual({ active: 0, redis: 0, queued: 0 });
      const weightedProvider = "spring-mouse:routing:{routing}:provider:v1:weighted";
      const weighted = await slots.reserveConnectionSlot([{id:"weighted",limit:8}], {providerId:"weighted",providerLimit:8,weight:7}); leases.push(weighted);
      // A hold exceeding the 3s lease must renew all seven members in BOTH sets.
      await sleep(4200);
      expect(await admin.zCount(key("weighted"),Date.now(),"+inf")).toBe(7);
      expect(await admin.zCount(weightedProvider,Date.now(),"+inf")).toBe(7);
      await expect(slots.reserveConnectionSlot([{id:"weighted",limit:8}], {providerId:"weighted",providerLimit:8,weight:2,queueTimeoutMs:50})).rejects.toMatchObject({reason:"queue_timeout"});
      // Combo admission must preserve the same Redis caps, but never wait for
      // a saturated channel while another candidate could serve the request.
      const fallbackStart = Date.now();
      await expect(slots.reserveConnectionSlot([{id:"weighted",limit:8}], {
        providerId:"weighted", providerLimit:8, weight:2, queueTimeoutMs:60000, waitForCapacity:false,
      })).rejects.toMatchObject({reason:"capacity_exhausted"});
      expect(Date.now() - fallbackStart).toBeLessThan(1500);
      expect(slots.getLocalSlotStatus().queued).toBe(0);
      expect(await admin.zCard(weightedProvider)).toBe(7);
      await weighted.release();
      expect(await admin.zCard(weightedProvider)).toBe(0);
      expect(await admin.zCard(key("weighted"))).toBe(0);

      // Model recovery must be single-flight even when the account's normal
      // limit and request weights allow several concurrent requests.
      const recoveryCandidates = [{id:"recovery",limit:30,requireIdle:true}];
      const recoveryOptions = {providerId:"recovery",providerLimit:30,weight:2,waitForCapacity:false};
      const recoveryResults = await Promise.allSettled(Array.from({length:12}, () => slots.reserveConnectionSlot(recoveryCandidates,recoveryOptions)));
      const probes = recoveryResults.filter(r => r.status === "fulfilled").map(r => r.value);
      leases.push(...probes);
      expect(probes).toHaveLength(1);
      expect(await admin.zCard(key("recovery"))).toBe(2);
      expect(recoveryResults.filter(r => r.status === "rejected").every(r => r.reason.reason === "capacity_exhausted")).toBe(true);
      // A second worker with an independent queue ticket also cannot reserve.
      const recoveryQueue = "spring-mouse:routing:{routing}:queue:v2:recovery";
      const otherTicket = JSON.stringify({id:"other-worker",at:Date.now(),keys:[key("recovery")]});
      await admin.zAdd(recoveryQueue,[{score:Date.now()+5000,value:otherTicket}]);
      expect(await admin.eval(slots.HARD_RESERVE_SCRIPT, {
        keys:["spring-mouse:routing:{routing}:provider:v1:recovery",recoveryQueue,key("recovery")],
        arguments:["other-lease","3000","30","7","30",otherTicket,"1000","3000",String(Date.now()+5000),"[true]"],
      })).toBe(0);
      await admin.zRem(recoveryQueue,otherTicket);
      await probes[0].release();
      const recoveryProbe = await slots.reserveConnectionSlot(recoveryCandidates,{...recoveryOptions,weight:7});
      leases.push(recoveryProbe);
      expect(await admin.zCard(key("recovery"))).toBe(7);
      await recoveryProbe.release();

      // Production regression: two weight-8 requests cannot share a 15-slot
      // account. Cap estimated weights at 7, preserving parallel progress.
      const oddCandidates = [{id:"odd-capacity",limit:15}];
      const estimated = slots.estimateRequestWeight({input:"x".repeat(1_000_000)}, slots.getRequestWeightLimit(oddCandidates,50));
      expect(estimated).toBe(7);
      const oddOptions = {providerId:"odd",providerLimit:50,weight:estimated,queueTimeoutMs:50};
      const parallel = await Promise.all([slots.reserveConnectionSlot(oddCandidates,oddOptions),slots.reserveConnectionSlot(oddCandidates,oddOptions)]);
      leases.push(...parallel);
      expect(await admin.zCard(key("odd-capacity"))).toBe(14);
      await expect(slots.reserveConnectionSlot(oddCandidates,oddOptions)).rejects.toMatchObject({reason:"queue_timeout"});
      await Promise.all(parallel.map(l => l.release()));

      // Cross-worker queue admission is atomic, independent of the local guard.
      const q = "spring-mouse:routing:{routing}:queue:v2:atomic";
      const enrolled = await Promise.all(Array.from({length:30}, (_,i) => admin.eval(slots.ENQUEUE_SCRIPT, {
        keys:[q],arguments:["3",String(Date.now()+5000),JSON.stringify({id:String(i),at:Date.now(),keys:[]}),"10000"],
      })));
      expect(enrolled.filter(n => n === 1)).toHaveLength(3);
      expect(await admin.zCard(q)).toBe(3); await admin.del(q);

      // An aged heavy waiter reserves overlapping accounts; pinned routes to
      // disjoint accounts can still proceed. Test ordering at the Lua boundary.
      const fairQueue = "spring-mouse:routing:{routing}:queue:v2:fair";
      const older = JSON.stringify({id:"older",at:Date.now()-2000,keys:[key("shared")]});
      await admin.zAdd(fairQueue,[{score:Date.now()+5000,value:older}]);
      await expect(slots.reserveConnectionSlot([{id:"shared",limit:8}], {providerId:"fair",providerLimit:16,queueTimeoutMs:60})).rejects.toMatchObject({reason:"queue_timeout"});
      const disjoint = await slots.reserveConnectionSlot([{id:"disjoint",limit:8}], {providerId:"fair",providerLimit:16}); leases.push(disjoint);
      expect(disjoint.connectionId).toBe("disjoint"); await disjoint.release();
      // The oldest request itself can take the free capacity, consuming its ticket.
      expect(await admin.eval(slots.HARD_RESERVE_SCRIPT, {
        keys:["spring-mouse:routing:{routing}:provider:v1:fair",fairQueue,key("shared")],
        arguments:["older-lease","3000","16","7","8",older,"1000"],
      })).toBe(1);
      expect(await admin.zCard(key("shared"))).toBe(7);
      expect(await admin.zCard(fairQueue)).toBe(0);
      await admin.del([key("shared"),"spring-mouse:routing:{routing}:provider:v1:fair"]);
      // A worker that enrolls and dies must not leave a fairness blocker for
      // the full 60-second request budget. Only live pollers extend waiter TTL.
      const orphanQueue = "spring-mouse:routing:{routing}:queue:v2:orphan";
      const orphan = JSON.stringify({id:"dead-worker",at:Date.now()-2000,keys:[key("orphan-account")]});
      await admin.eval(slots.ENQUEUE_SCRIPT,{keys:[orphanQueue],arguments:["50",String(Date.now()+60000),orphan,"120000","","150"]});
      expect(Number(await admin.zScore(orphanQueue,orphan))-Date.now()).toBeLessThanOrEqual(150);
      const recovered = await slots.reserveConnectionSlot([{id:"orphan-account",limit:8}], {providerId:"orphan",providerLimit:8,queueTimeoutMs:1500}); leases.push(recovered);
      expect(recovered.connectionId).toBe("orphan-account");
      expect(await admin.zCard(orphanQueue)).toBe(0); await recovered.release();
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
      await fs.rm(temp, {recursive:true,force:true});
    }
  }, 20000);
});
