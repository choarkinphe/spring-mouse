import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSystemoneCore, validateSystemoneRequest } from "../../open-sse/handlers/systemoneCore.js";
import { JEVAPI_CONFIG } from "../../open-sse/config/jevapi.js";

const body = {
  model: "jevapi/jev-latest",
  state: { ticket: "My payouts have failed for three days" },
  questions: {
    urgent: { type: "noul", instructions: "Is this urgent?", criteria: { true: "Time sensitive", false: "Routine" } },
    team: { type: "choice", instructions: { question: "Which team?" }, criteria: { billing: null, technical: "Bugs" } },
    frustration: { type: "score", instructions: ["Rate frustration"], criteria: ["Calm", "Frustrated", "Angry"] },
  },
};
const payload = {
  model: "jev-1.13.0",
  answers: {
    urgent: { type: "noul", noul: 0.95 },
    team: { type: "choice", choice: "billing", probabilities: { billing: 0.9, technical: 0.1 }, confidence: 0.8 },
    frustration: { type: "score", score: 1.1, probabilities: { 0: 0, 1: 0.9, 2: 0.1 }, confidence: 0.8, legend: { 0: "Calm", 1: "Frustrated", 2: "Angry" } },
  },
  usage: { input_tokens: 318, output_tokens: 34 },
};
const run = (overrides = {}) => handleSystemoneCore({ body, modelInfo: { provider: "jevapi", model: "jev-latest" }, credentials: { apiKey: "upstream-test-key" }, ...overrides });

beforeEach(() => vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(payload))));
afterEach(() => vi.unstubAllGlobals());

describe("System One native request validation", () => {
  it("accepts all three primitives and structured instructions", () => expect(validateSystemoneRequest(body)).toBeNull());
  it.each([null, [], {}, { ...body, model: [] }, { ...body, state: null }, { ...body, state: 42 }, { ...body, questions: {} }, { ...body, stream: true },
    ...[
      { type: "chat", instructions: "hi" },
      { type: "noul", instructions: null },
      { type: "noul", instructions: "hi", criteria: { yes: "Yes" } },
      { type: "choice", instructions: "hi", criteria: {} },
      { type: "choice", instructions: "hi", criteria: { a: 10 } },
      { type: "choice", instructions: "hi", criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [i, null])) },
      { type: "score", instructions: "hi", criteria: ["one"] },
      { type: "score", instructions: "hi", criteria: Array(11).fill("level") },
      { type: "score", instructions: "hi", criteria: ["one", null] },
    ].map((question) => ({ ...body, questions: { q: question } })),
  ])("rejects malformed input %# before any upstream call", async (invalid) => {
    expect(validateSystemoneRequest(invalid)).toEqual(expect.any(String));
    expect((await run({ body: invalid })).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("System One native transport", () => {
  it("uses only the upstream key and preserves native answers, distributions, model and usage", async () => {
    const result = await run({ body: { ...body, apiKey: "client-key", stream: false, extra: "not upstream" } });
    expect(result.success).toBe(true);
    expect(await result.response.json()).toEqual(payload);
    expect(result.usage).toEqual(payload.usage);
    expect(fetch).toHaveBeenCalledWith(JEVAPI_CONFIG.baseUrl, expect.objectContaining({
      method: "POST", headers: { Authorization: "Bearer upstream-test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "jev-latest", state: body.state, questions: body.questions }),
    }));
  });
  it.each([401, 422, 429, 529])("preserves native %s errors and retry-after without immediate retries", async (status) => {
    const detail = { detail: [{ loc: ["body", "questions"], msg: "fixture error" }] };
    fetch.mockResolvedValue(Response.json(detail, { status, headers: { "Retry-After": "30", "Set-Cookie": "upstream-secret=x" } }));
    const result = await run();
    expect(result.status).toBe(status);
    expect(result.upstreamError).toMatchObject({ source: "http", retryAfterMs: 30000, status });
    expect(await result.response.json()).toEqual(detail);
    expect(result.response.headers.get("retry-after")).toBe("30");
    expect(result.response.headers.has("set-cookie")).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects wrong provider and missing credentials without fetching", async () => {
    expect((await run({ modelInfo: { provider: "openai", model: "gpt-test" } })).status).toBe(400);
    expect((await run({ credentials: {} })).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["not-json", JSON.stringify({ model: "jev", answers: {} }), JSON.stringify({ ...payload, answers: { ...payload.answers, urgent: { type: "choice" } } })])("rejects invalid upstream successes %#", async (text) => {
    fetch.mockResolvedValue(new Response(text));
    expect((await run()).status).toBe(502);
  });
  it("maps network errors without exposing credentials", async () => {
    fetch.mockRejectedValue(new Error("failure upstream-test-key"));
    const result = await run();
    expect(result.status).toBe(502);
    expect(await result.response.text()).not.toContain("upstream-test-key");
  });
  it("maps a timed-out upstream request to 504", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("timeout", "TimeoutError"));
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    fetch.mockRejectedValue(new DOMException("timeout", "TimeoutError"));
    try {
      expect((await run()).status).toBe(504);
    } finally {
      timeout.mockRestore();
    }
  });
  it("propagates client cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    fetch.mockRejectedValue(new DOMException("aborted", "AbortError"));
    expect((await run({ signal: controller.signal })).status).toBe(499);
  });
});
