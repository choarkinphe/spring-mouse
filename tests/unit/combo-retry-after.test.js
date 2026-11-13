import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleComboChat } from "../../open-sse/services/combo.js";
import { unavailableResponse } from "../../open-sse/utils/error.js";

const NOW = Date.parse("2026-11-13T12:00:00Z");
const iso = (seconds) => new Date(NOW + seconds * 1000).toISOString();
const httpDate = (seconds) => new Date(NOW + seconds * 1000).toUTCString();
const log = { info: vi.fn(), warn: vi.fn() };
const body = { messages: [{ role: "user", content: "hello" }], stream: false };

function failure({ header, retryAfter, status = 503, text } = {}) {
  const headers = header === undefined ? {} : { "Retry-After": header };
  return text === undefined
    ? Response.json({ error: { message: "temporarily unavailable" }, retryAfter }, { status, headers })
    : new Response(text, { status, headers });
}

function route(handleSingleModel, models = ["test/first", "test/second"], options = {}) {
  return handleComboChat({ body, models, handleSingleModel, log, comboStrategy: "fallback", autoSwitch: false, ...options });
}

async function exhaust(responses) {
  const handleSingleModel = vi.fn();
  for (const response of responses) handleSingleModel.mockResolvedValueOnce(response);
  const result = await route(handleSingleModel, responses.map((_, i) => `test/model-${i}`));
  expect(handleSingleModel).toHaveBeenCalledTimes(responses.length);
  expect(result.status).toBe(responses[0].status);
  expect(vi.getTimerCount()).toBe(0);
  return result;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network is forbidden in combo retry-after tests"); }));
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("combo Retry-After propagation", () => {
  it.each([
    ["delta-seconds", { header: "30" }],
    ["HTTP-date", { header: httpDate(30) }],
    ["obsolete RFC 850 HTTP-date", { header: "Friday, 13-Nov-26 12:00:30 GMT" }],
    ["obsolete asctime HTTP-date", { header: "Fri Nov 13 12:00:30 2026" }],
    ["legacy JSON ISO", { retryAfter: iso(30) }],
    ["unavailableResponse header", null],
    ["header with a non-JSON body", { header: "30", text: "upstream unavailable" }],
  ])("preserves %s after all members fail", async (_name, options) => {
    const first = options ? failure(options) : unavailableResponse(503, "busy", iso(30), "reset after 30s");
    const result = await exhaust([first, failure()]);
    expect(result.headers.get("Retry-After")).toBe("30");
    expect((await result.json()).error.message).toContain("reset after 30s");
    // Reading a clone must not consume or mutate the original failed response.
    expect(first.bodyUsed).toBe(false);
  });

  it("selects the earliest valid hint across headers, JSON and members, regardless of order", async () => {
    const result = await exhaust([
      failure({ retryAfter: "invalid timestamp" }),
      failure({ header: "90", retryAfter: iso(60) }),
      failure({ header: httpDate(20), retryAfter: iso(40) }),
      failure({ header: "50", retryAfter: iso(10) }),
      failure({ header: "120" }),
    ]);
    expect(result.headers.get("Retry-After")).toBe("10");
  });

  it.each([
    ["invalid", "not a date"],
    ["empty", ""],
    ["zero", "0"],
    ["negative", "-1"],
    ["fractional", "1.5"],
    ["signed", "+30"],
    ["numeric date-like string", "2026-11-13"],
    ["ISO instead of HTTP-date", iso(10)],
    ["date with junk prefix", "junk Fri, 13 Nov 2026 12:00:30 GMT"],
    ["non-finite", "Infinity"],
    ["overflow", "9".repeat(400)],
    ["outside Date range", "9000000000000"],
    ["expired HTTP-date", httpDate(-10)],
    ["current HTTP-date", httpDate(0)],
  ])("ignores %s header without throwing or skipping fallback", async (_name, header) => {
    const result = await exhaust([failure({ header }), failure({ retryAfter: iso(25) })]);
    expect(result.headers.get("Retry-After")).toBe("25");
    expect(log.warn.mock.calls.some(([, message]) => message.includes("threw error"))).toBe(false);
  });

  it.each([null, "", "not a date", "12", "2026-11-13", iso(-1), iso(0), 123, {}, [], true])(
    "ignores invalid/expired JSON hint %j and still reads the header",
    async (retryAfter) => {
      const result = await exhaust([failure({ header: "15", retryAfter }), failure()]);
      expect(result.headers.get("Retry-After")).toBe("15");
      expect(log.warn.mock.calls.some(([, message]) => message.includes("threw error"))).toBe(false);
    },
  );

  it("does not emit Retry-After when no valid future hints exist", async () => {
    const result = await exhaust([
      failure({ header: "garbage", retryAfter: "invalid" }),
      failure({ header: httpDate(-10), retryAfter: iso(-20) }),
      failure({ text: "not JSON" }),
    ]);
    expect(result.headers.has("Retry-After")).toBe(false);
  });

  it("discards hints that expire during fallback and keeps the next future time", async () => {
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(failure({ header: "5" }))
      .mockResolvedValueOnce(failure({ retryAfter: iso(30) }))
      .mockImplementationOnce(async () => {
        vi.setSystemTime(NOW + 10000);
        return failure();
      });
    const result = await route(handleSingleModel, ["test/first", "test/second", "test/third"]);
    expect(result.headers.get("Retry-After")).toBe("20");
    expect(handleSingleModel).toHaveBeenCalledTimes(3);
  });

  it("omits the header if every collected hint expires during fallback", async () => {
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(failure({ retryAfter: iso(5) }))
      .mockImplementationOnce(async () => {
        vi.setSystemTime(NOW + 10000);
        return failure();
      });
    expect((await route(handleSingleModel)).headers.has("Retry-After")).toBe(false);
  });

  it("survives multiple nested combo wrappers and compares their hints with sibling members", async () => {
    const graph = {
      outer: ["middle", "test/outer"],
      middle: ["inner", "test/middle"],
      inner: ["test/inner"],
    };
    const leaf = vi.fn(async (_body, model) => failure({ header: { "test/inner": "40", "test/middle": "20", "test/outer": "60" }[model] }));
    const dispatch = async (requestBody, model, context) => graph[model]
      ? route(dispatch, graph[model], { body: requestBody, comboName: model, ...context })
      : leaf(requestBody, model);
    const result = await dispatch(body, "outer", {});
    expect(result.headers.get("Retry-After")).toBe("20");
    expect(leaf.mock.calls.map(([, model]) => model)).toEqual(["test/inner", "test/middle", "test/outer"]);
  });

  it("falls back immediately without waiting for cooldown or polluting a later success", async () => {
    const success = Response.json({ answer: "ok" }, { headers: { "X-Upstream": "healthy" } });
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(failure({ header: "3600", retryAfter: iso(7200) }))
      .mockResolvedValueOnce(success);
    const result = await route(handleSingleModel, undefined, { deadlineMs: NOW + 1000 });
    expect(result).toBe(success);
    expect(result.headers.has("Retry-After")).toBe(false);
    expect(result.headers.get("X-Upstream")).toBe("healthy");
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(handleSingleModel.mock.calls.map(([, , context]) => context.hasFallback)).toEqual([true, false]);
    expect(Date.now()).toBe(NOW);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns a later non-fallback error unchanged instead of adding a previous hint", async () => {
    const clientError = failure({ status: 400, text: "malformed request" });
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(failure({ header: "30" }))
      .mockResolvedValueOnce(clientError);
    expect(await route(handleSingleModel)).toBe(clientError);
    expect(clientError.headers.has("Retry-After")).toBe(false);
  });
});
