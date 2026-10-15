import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { aggregate } = vi.hoisted(() => ({ aggregate: vi.fn() }));
vi.mock("@/lib/db/usageAggregatePool.js", () => ({ runUsageAggregation: aggregate }));

let tempDir;
let clock;
let getUsageStats;
let notifyUsageCommitted;
const originalDataDir = process.env.DATA_DIR;

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const entry = () => [...global._usageStatsCache.values()][0];
const stats = (totalRequests) => ({ totalRequests });

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sm-stats-flight-"));
  process.env.DATA_DIR = tempDir;
  for (const key of ["_dbAdapter", "_usageStatsCache", "_statsEmitter", "_statsEmitTimers"]) delete global[key];
  vi.resetModules();
  aggregate.mockReset();
  const db = await import("@/lib/db/index.js");
  await db.initDb();
  ({ getUsageStats, notifyUsageCommitted } = await import("@/lib/db/repos/usageRepo.js"));
  clock = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => clock);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const timer of Object.values(global._statsEmitTimers || {})) clearTimeout(timer);
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  delete global._usageStatsCache;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("slow usage aggregations stay single-flight", () => {
  it("joins an initial scan even after expiry and starts freshness at completion", async () => {
    const scan = deferred();
    aggregate.mockReturnValue(scan.promise);
    const first = getUsageStats("all");
    await vi.waitFor(() => expect(aggregate).toHaveBeenCalledTimes(1));
    const original = entry().promise;
    clock += 20_000;
    notifyUsageCommitted();
    const second = getUsageStats("all");
    const shared = entry().promise;
    scan.resolve(stats(10));
    const results = await Promise.all([first, second]);
    expect(shared).toBe(original);
    expect(aggregate).toHaveBeenCalledTimes(1);
    expect(results.map((x) => x.totalRequests)).toEqual([10, 10]);
    expect(entry().createdAt).toBe(clock);
  });

  it("joins an expired background refresh instead of launching another scan", async () => {
    aggregate.mockResolvedValueOnce(stats(10));
    await getUsageStats("all");
    clock += 6_000;
    notifyUsageCommitted();
    const scan = deferred();
    aggregate.mockReturnValue(scan.promise);
    expect((await getUsageStats("all")).totalRequests).toBe(10);
    await vi.waitFor(() => expect(aggregate).toHaveBeenCalledTimes(2));
    const refresh = entry().refreshPromise;
    clock += 20_000;
    notifyUsageCommitted();
    const waiting = getUsageStats("all");
    const sameRefresh = entry().refreshPromise;
    scan.resolve(stats(12));
    expect((await waiting).totalRequests).toBe(12);
    expect(sameRefresh).toBe(refresh);
    expect(aggregate).toHaveBeenCalledTimes(2);
  });

  it("propagates refresh failure to expired waiters and allows a retry", async () => {
    aggregate.mockResolvedValueOnce(stats(10));
    await getUsageStats("all");
    clock += 6_000;
    const scan = deferred();
    aggregate.mockReturnValue(scan.promise);
    await getUsageStats("all");
    await vi.waitFor(() => expect(aggregate).toHaveBeenCalledTimes(2));
    clock += 20_000;
    const waiting = getUsageStats("all");
    const assertion = expect(waiting).rejects.toThrow("scan failed");
    scan.reject(new Error("scan failed"));
    await assertion;
    aggregate.mockResolvedValue(stats(15));
    expect((await getUsageStats("all")).totalRequests).toBe(15);
  });
});
