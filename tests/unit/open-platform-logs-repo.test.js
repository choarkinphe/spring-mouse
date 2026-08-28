import { beforeEach, describe, expect, it, vi } from "vitest";

const state = { rows: [], nextId: 1 };

const adapter = {
  run: vi.fn((sql, params = []) => {
    if (!sql.startsWith("INSERT INTO openPlatformApiCallLogs")) return { changes: 0 };
    const [
      apiKeyId, keyName, keyPrefix, timestamp, method, path, statusCode,
      durationMs, sourceIp, userAgent, subjectUserId,
    ] = params;
    const id = state.nextId++;
    state.rows.push({
      id, apiKeyId, keyName, keyPrefix, timestamp, method, path, statusCode,
      durationMs, sourceIp, userAgent, subjectUserId,
    });
    return { changes: 1, lastInsertRowid: id };
  }),
  get: vi.fn((sql, params = []) => {
    if (!sql.startsWith("SELECT COUNT(*)")) return null;
    const rows = sql.includes("WHERE apiKeyId = ?")
      ? state.rows.filter((row) => row.apiKeyId === params[0])
      : state.rows;
    return { total: rows.length };
  }),
  all: vi.fn((sql, params = []) => {
    if (!sql.startsWith("SELECT * FROM openPlatformApiCallLogs")) return [];
    const filtered = sql.includes("WHERE apiKeyId = ?")
      ? state.rows.filter((row) => row.apiKeyId === params[0])
      : state.rows;
    const [limit, offset] = params.slice(-2);
    return [...filtered].sort((a, b) => b.id - a.id).slice(offset, offset + limit);
  }),
};

vi.mock("@/lib/db/driver.js", () => ({ getAdapter: vi.fn(async () => adapter) }));

const {
  getOpenPlatformApiCallLogs,
  recordOpenPlatformApiCall,
} = await import("@/lib/db/repos/openPlatformLogsRepo.js");

function logEntry(overrides = {}) {
  return {
    apiKeyId: "key-a",
    keyName: "BI",
    keyPrefix: "smop_example",
    timestamp: "2026-08-29T09:30:00.000Z",
    method: "GET",
    path: "/open/v1/users",
    statusCode: 200,
    durationMs: 12,
    sourceIp: "10.0.0.1",
    userAgent: "vitest",
    subjectUserId: null,
    ...overrides,
  };
}

describe("open platform call log repository", () => {
  beforeEach(() => {
    state.rows.length = 0;
    state.nextId = 1;
    vi.clearAllMocks();
  });

  it("persists a normalized call record", async () => {
    const saved = await recordOpenPlatformApiCall(logEntry({ durationMs: -8 }));

    expect(saved).toMatchObject({ id: 1, apiKeyId: "key-a", path: "/open/v1/users" });
    expect(state.rows[0]).toMatchObject({ durationMs: 0, statusCode: 200, sourceIp: "10.0.0.1" });
  });

  it("filters by API key and returns newest calls first", async () => {
    await recordOpenPlatformApiCall(logEntry({ apiKeyId: "key-a", path: "/open/v1/users" }));
    await recordOpenPlatformApiCall(logEntry({ apiKeyId: "key-b", keyName: "Audit", path: "/open/v1/usage/report" }));
    await recordOpenPlatformApiCall(logEntry({ apiKeyId: "key-a", path: "/open/v1/usage/report", subjectUserId: "user-1" }));

    const result = await getOpenPlatformApiCallLogs({ apiKeyId: "key-a" });

    expect(result.logs).toHaveLength(2);
    expect(result.logs.map((log) => log.path)).toEqual(["/open/v1/usage/report", "/open/v1/users"]);
    expect(result.pagination).toEqual({ page: 1, pageSize: 30, totalItems: 2, totalPages: 1 });
  });

  it("paginates and caps page size", async () => {
    for (let index = 0; index < 4; index += 1) {
      await recordOpenPlatformApiCall(logEntry({ path: `/open/v1/example/${index}` }));
    }

    const page = await getOpenPlatformApiCallLogs({ page: 2, pageSize: 2 });
    const capped = await getOpenPlatformApiCallLogs({ pageSize: 200 });

    expect(page.logs.map((log) => log.path)).toEqual(["/open/v1/example/1", "/open/v1/example/0"]);
    expect(page.pagination).toEqual({ page: 2, pageSize: 2, totalItems: 4, totalPages: 2 });
    expect(capped.pagination.pageSize).toBe(100);
  });
});
