import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getAdapter: vi.fn() }));
vi.mock("@/lib/db/driver.js", () => ({ getAdapter: mocks.getAdapter }));

function createDb() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`
    CREATE TABLE routingRequests (
      routingRequestId TEXT PRIMARY KEY, modelCallId TEXT, trafficRequestId TEXT,
      originalModel TEXT, endpoint TEXT, role TEXT NOT NULL DEFAULT 'primary',
      requestType TEXT, comboName TEXT, strategy TEXT, autoSource TEXT,
      autoLevel TEXT, autoConfidence REAL, startedAt TEXT NOT NULL,
      completedAt TEXT, outcome TEXT NOT NULL DEFAULT 'unknown', terminalReason TEXT,
      attemptCount INTEGER NOT NULL DEFAULT 0, meta TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE routingAttempts (
      attemptId TEXT PRIMARY KEY, routingRequestId TEXT NOT NULL, modelCallId TEXT,
      role TEXT NOT NULL DEFAULT 'primary', provider TEXT, model TEXT,
      connectionId TEXT, routeIndex INTEGER, candidateIndex INTEGER,
      sourceFormat TEXT, targetFormat TEXT, nativePassthrough INTEGER NOT NULL DEFAULT 0,
      streamMode TEXT, startedAt TEXT NOT NULL, completedAt TEXT, upstreamStatus INTEGER,
      outcome TEXT NOT NULL DEFAULT 'unknown', fallbackReason TEXT, terminalReason TEXT,
      ttftMs INTEGER, durationMs INTEGER, promptTokens INTEGER, completionTokens INTEGER,
      meta TEXT NOT NULL DEFAULT '{}'
    );
  `);
  const adapter = {
    run: (sql, params = []) => raw.prepare(sql).run(...params),
    get: (sql, params = []) => raw.prepare(sql).get(...params),
    all: (sql, params = []) => raw.prepare(sql).all(...params),
    close: () => raw.close(),
  };
  return adapter;
}

let db;
let repo;
let telemetry;

beforeEach(async () => {
  vi.resetModules();
  db = createDb();
  mocks.getAdapter.mockReset().mockResolvedValue(db);
  repo = await import("../../src/lib/db/repos/routingTelemetryRepo.js");
  telemetry = await import("../../src/shared/utils/routingTelemetry.js");
});

describe("routing telemetry repository", () => {
  it("writes idempotent request and attempt snapshots without usageHistory", async () => {
    const requestId = await repo.createRoutingRequest({
      routingRequestId: "request-1",
      originalModel: "combo-model",
      strategy: "fallback",
      startedAt: "2026-01-01T00:00:00Z",
      meta: { toolsCount: 2, hasImages: true, prompt: "must not persist" },
    });
    expect(requestId).toBe("request-1");
    expect(await repo.createRoutingRequest({
      routingRequestId: "request-1",
      originalModel: "different-model",
      startedAt: "2026-01-01T00:00:00Z",
    })).toBe("request-1");

    const attempt = await repo.createRoutingAttempt({
      attemptId: "attempt-1",
      routingRequestId: requestId,
      provider: "provider-a",
      model: "model-a",
      connectionId: "connection-a",
      startedAt: "2026-01-01T00:00:01Z",
      meta: { hasReasoning: true, content: "must not persist" },
    });
    expect(attempt).toEqual({ attemptId: "attempt-1", inserted: true });
    expect(await repo.createRoutingAttempt({ attemptId: "attempt-1", routingRequestId: requestId })).toEqual({
      attemptId: "attempt-1",
      inserted: false,
    });

    const request = db.get("SELECT * FROM routingRequests WHERE routingRequestId = ?", [requestId]);
    const persistedMeta = JSON.parse(request.meta);
    expect(request.originalModel).toBe("combo-model");
    expect(persistedMeta).toEqual({ toolsCount: 2, hasImages: true });
    expect(db.get("SELECT COUNT(*) AS count FROM routingAttempts").count).toBe(1);
    expect(() => db.get("SELECT COUNT(*) AS count FROM usageHistory")).toThrow();
  });

  it("latches terminal completion when finish arrives before start replay", () => {
    const finish = telemetry.normalizeRoutingEvent({
      kind: "attempt",
      record: {
        attemptId: "attempt-late",
        routingRequestId: "request-late",
        provider: "provider-a",
        model: "model-a",
        startedAt: "2026-01-02T00:00:00Z",
        completedAt: "2026-01-02T00:00:02Z",
        outcome: "failed",
        terminalReason: "upstream_http_error",
        durationMs: 2000,
      },
    });
    expect(telemetry.writeRoutingEvent(db, finish)).toMatchObject({ kind: "attempt", inserted: true });

    const start = telemetry.normalizeRoutingEvent({
      kind: "attempt",
      record: {
        attemptId: "attempt-late",
        routingRequestId: "request-late",
        provider: "provider-a",
        model: "model-a",
        startedAt: "2026-01-01T00:00:00Z",
        outcome: "unknown",
        meta: { hasTools: true },
      },
    });
    telemetry.writeRoutingEvent(db, start);

    const row = db.get("SELECT startedAt, completedAt, outcome, terminalReason, durationMs, meta FROM routingAttempts WHERE attemptId = ?", ["attempt-late"]);
    expect(row).toMatchObject({
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-02T00:00:02.000Z",
      outcome: "failed",
      terminalReason: "upstream_http_error",
      durationMs: 2000,
      meta: "{\"hasTools\":true}",
    });
  });

  it("uses a primary-only denominator and reports auxiliary groups separately", async () => {
    await repo.createRoutingRequest({ routingRequestId: "primary-request", role: "primary", startedAt: "2026-01-01T00:00:00Z" });
    await repo.completeRoutingRequest("primary-request", { outcome: "valid_terminal", completedAt: "2026-01-01T00:00:01Z" });
    await repo.createRoutingRequest({ routingRequestId: "judge-request", role: "judge", startedAt: "2026-01-01T00:00:00Z", outcome: "failed" });
    await repo.createRoutingAttempt({ attemptId: "primary-attempt", routingRequestId: "primary-request", role: "primary", provider: "p", model: "m", startedAt: "2026-01-01T00:00:00Z", durationMs: 100 });
    await repo.completeRoutingAttempt("primary-attempt", { outcome: "valid_terminal", completedAt: "2026-01-01T00:00:01Z", durationMs: 100 });
    await repo.createRoutingAttempt({ attemptId: "panel-attempt", routingRequestId: "primary-request", role: "panel", provider: "p", model: "m", startedAt: "2026-01-01T00:00:00Z", outcome: "failed" });

    const report = await repo.getRoutingOutcomes({ startDate: "2026-01-01", endDate: "2026-01-02" });
    expect(report.requestSuccessRate).toBe(1);
    expect(report.attemptSuccessRate).toBe(1);
    expect(report.requests.auxiliary.total).toBe(1);
    expect(report.attempts.auxiliary.total).toBe(1);
    expect(report.attempts.byProvider).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "p", role: "primary", total: 1 }),
    ]));
    expect(report.latency).toMatchObject({ sampleCount: 1, eligibleCount: 1, sampled: false });
  });

  it("rejects invalid calendar ranges and ranges longer than 30 days", () => {
    expect(() => repo.normalizeReportRange({ startDate: "2026-02-30", endDate: "2026-03-01" })).toThrow(RangeError);
    expect(() => repo.normalizeReportRange({ startDate: "2026-01-01", endDate: "2026-02-01" })).toThrow(/30 days/);
    expect(repo.normalizeReportRange({ startDate: "2026-01-01", endDate: "2026-01-02" })).toEqual({
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-02T00:00:00.000Z",
    });
  });
});
