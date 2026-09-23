import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Backfill rewrites stored billing figures, so these tests focus on the safety
 * properties: it must repair a stale `0`, must not touch rows that are already
 * correct, must leave still-unpriced rows alone, and `dryRun` must write nothing.
 */

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "spring-mouse-backfill-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

// Insert a usage row directly so we control the stored cost (simulating a row
// written back when the model had no price).
async function insertRow(db, { requestId, provider, model, tokens, cost, status = "success" }) {
  db.run(
    `INSERT INTO usageHistory(timestamp, provider, model, requestId, startedAt, completedAt, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "2026-09-01T00:00:00.000Z", provider, model, requestId,
      "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z", "/v1/chat/completions",
      tokens.prompt_tokens || 0, tokens.completion_tokens || 0, cost, status,
      JSON.stringify(tokens), "{}",
    ],
  );
}

async function readCost(db, requestId) {
  return db.get(`SELECT cost FROM usageHistory WHERE requestId = ?`, [requestId])?.cost;
}

describe("backfillUsageCost", () => {
  it("repairs a stale zero once the model has a price", async () => {
    const { getAdapter } = await import("../../src/lib/db/driver.js");
    const { backfillUsageCost } = await import("../../src/lib/db/repos/usageRepo.js");
    const { updatePricing } = await import("../../src/lib/db/repos/pricingRepo.js");
    const db = await getAdapter();

    // gpt-5.6-sol is in MODEL_PRICING at 5/30; record it as $0 the way a
    // pre-pricing write would have.
    await insertRow(db, {
      requestId: "repair-me", provider: "codex", model: "gpt-5.6-sol",
      tokens: { prompt_tokens: 1_000_000, completion_tokens: 0, cached_tokens: 0 }, cost: 0,
    });
    await updatePricing({ codex: { "gpt-5.6-sol": { input: 5, output: 30 } } });

    const summary = await backfillUsageCost({});

    expect(summary.changed).toBe(1);
    expect(summary.delta).toBeCloseTo(5, 6);
    expect(await readCost(db, "repair-me")).toBeCloseTo(5, 6);
  });

  it("leaves an already-correct row untouched", async () => {
    const { getAdapter } = await import("../../src/lib/db/driver.js");
    const { backfillUsageCost } = await import("../../src/lib/db/repos/usageRepo.js");
    const { updatePricing } = await import("../../src/lib/db/repos/pricingRepo.js");
    const db = await getAdapter();

    await updatePricing({ codex: { "gpt-5.6-sol": { input: 5, output: 30 } } });
    // Exactly what calculateCost would produce for 1M input tokens at $5/M.
    await insertRow(db, {
      requestId: "already-right", provider: "codex", model: "gpt-5.6-sol",
      tokens: { prompt_tokens: 1_000_000, completion_tokens: 0, cached_tokens: 0 }, cost: 5,
    });

    const summary = await backfillUsageCost({});

    expect(summary.changed).toBe(0);
    expect(summary.unchanged).toBe(1);
    expect(await readCost(db, "already-right")).toBe(5);
  });

  it("does not silently rewrite a row the tables still cannot price", async () => {
    const { getAdapter } = await import("../../src/lib/db/driver.js");
    const { backfillUsageCost } = await import("../../src/lib/db/repos/usageRepo.js");
    const db = await getAdapter();

    await insertRow(db, {
      requestId: "no-price", provider: "codex", model: "totally-unknown-model",
      tokens: { prompt_tokens: 500, completion_tokens: 10 }, cost: 0,
    });

    const summary = await backfillUsageCost({});

    expect(summary.unpriced).toBe(1);
    expect(summary.changed).toBe(0);
    expect(await readCost(db, "no-price")).toBe(0);
  });

  it("dryRun computes the delta but writes nothing", async () => {
    const { getAdapter } = await import("../../src/lib/db/driver.js");
    const { backfillUsageCost } = await import("../../src/lib/db/repos/usageRepo.js");
    const { updatePricing } = await import("../../src/lib/db/repos/pricingRepo.js");
    const db = await getAdapter();

    await updatePricing({ codex: { "gpt-5.6-sol": { input: 5, output: 30 } } });
    await insertRow(db, {
      requestId: "dry", provider: "codex", model: "gpt-5.6-sol",
      tokens: { prompt_tokens: 1_000_000, completion_tokens: 0, cached_tokens: 0 }, cost: 0,
    });

    const summary = await backfillUsageCost({ dryRun: true });

    expect(summary.dryRun).toBe(true);
    expect(summary.changed).toBe(1);
    expect(summary.delta).toBeCloseTo(5, 6);
    // The row must be untouched.
    expect(await readCost(db, "dry")).toBe(0);
  });

  it("scopes to one provider when asked", async () => {
    const { getAdapter } = await import("../../src/lib/db/driver.js");
    const { backfillUsageCost } = await import("../../src/lib/db/repos/usageRepo.js");
    const { updatePricing } = await import("../../src/lib/db/repos/pricingRepo.js");
    const db = await getAdapter();

    await updatePricing({
      codex: { "gpt-5.6-sol": { input: 5, output: 30 } },
      deepseek: { "deepseek-v4-flash": { input: 0.14, output: 0.28 } },
    });
    await insertRow(db, {
      requestId: "cx-row", provider: "codex", model: "gpt-5.6-sol",
      tokens: { prompt_tokens: 1_000_000, completion_tokens: 0 }, cost: 0,
    });
    await insertRow(db, {
      requestId: "ds-row", provider: "deepseek", model: "deepseek-v4-flash",
      tokens: { prompt_tokens: 1_000_000, completion_tokens: 0 }, cost: 0,
    });

    const summary = await backfillUsageCost({ provider: "codex" });

    expect(summary.scanned).toBe(1);
    expect(summary.changed).toBe(1);
    expect(await readCost(db, "cx-row")).toBeCloseTo(5, 6);
    // The deepseek row was out of scope and must be untouched.
    expect(await readCost(db, "ds-row")).toBe(0);
  });

  it("is idempotent — a second run changes nothing", async () => {
    const { getAdapter } = await import("../../src/lib/db/driver.js");
    const { backfillUsageCost } = await import("../../src/lib/db/repos/usageRepo.js");
    const { updatePricing } = await import("../../src/lib/db/repos/pricingRepo.js");
    const db = await getAdapter();

    await updatePricing({ codex: { "gpt-5.6-sol": { input: 5, output: 30 } } });
    await insertRow(db, {
      requestId: "once", provider: "codex", model: "gpt-5.6-sol",
      tokens: { prompt_tokens: 1_000_000, completion_tokens: 0 }, cost: 0,
    });

    const first = await backfillUsageCost({});
    const second = await backfillUsageCost({});

    expect(first.changed).toBe(1);
    expect(second.changed).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(await readCost(db, "once")).toBeCloseTo(5, 6);
  });

  it("batches across multiple passes without skipping or duplicating rows", async () => {
    const { getAdapter } = await import("../../src/lib/db/driver.js");
    const { backfillUsageCost } = await import("../../src/lib/db/repos/usageRepo.js");
    const { updatePricing } = await import("../../src/lib/db/repos/pricingRepo.js");
    const db = await getAdapter();

    await updatePricing({ codex: { "gpt-5.6-sol": { input: 5, output: 30 } } });
    for (let i = 0; i < 5; i++) {
      await insertRow(db, {
        requestId: `batch-${i}`, provider: "codex", model: "gpt-5.6-sol",
        tokens: { prompt_tokens: 1_000_000, completion_tokens: 0 }, cost: 0,
      });
    }

    // batchSize 2 forces three passes over five rows.
    const summary = await backfillUsageCost({ batchSize: 2 });

    expect(summary.scanned).toBe(5);
    expect(summary.changed).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(await readCost(db, `batch-${i}`)).toBeCloseTo(5, 6);
    }
  });
});
