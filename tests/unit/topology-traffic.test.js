import { describe, expect, it } from "vitest";
import { getTokenMotion, getTopologyRequests, makeTokenPath } from "../../src/shared/utils/topologyTraffic.js";
import { createLiveTokenProgress } from "../../open-sse/utils/liveTokenProgress.js";

describe("token-driven topology", () => {
  it("keeps zero/invalid lanes quiet and bounds high-volume particle cost", () => {
    for (const value of [0, null, undefined, -2, NaN, Infinity]) expect(getTokenMotion(value).count).toBe(0);
    const small = getTokenMotion(100);
    const large = getTokenMotion(100000);
    expect(large.count).toBeGreaterThan(small.count);
    expect(large.duration).toBeLessThan(small.duration);
    expect(getTokenMotion(1e30).count).toBe(10);
    expect(getTokenMotion(1e30).duration).toBeGreaterThanOrEqual(0.9);
  });

  it("preserves live counts, deduplicates final usage and expires only completed routes", () => {
    const now = Date.now();
    const active = { provider: "codex", count: 2, inputTokens: 200, outputTokens: 20 };
    const recent = { provider: "codex", requestId: "r1", timestamp: new Date(now - 1000).toISOString(), promptTokens: 100, completionTokens: 10, apiKeyId: "key1", userName: "Alice" };
    const result = getTopologyRequests([active], [recent, recent, { ...recent, requestId: "old", timestamp: new Date(now - 6000).toISOString() }], now);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(active);
    expect(result[1]).toMatchObject({ count: 0, inputTokens: 100, outputTokens: 10, apiKey: { id: "key1", name: "Alice" } });
    expect(getTopologyRequests([active], [recent], now + 7000)).toEqual([active]);
  });

  it("makes two separated paths with correct request/response directions", () => {
    const providerInput = makeTokenPath(500, 100, 1000, 600, false, -4);
    const providerOutput = makeTokenPath(500, 100, 1000, 600, true, 4);
    expect(providerInput).toMatch(/^M 496 300/);
    expect(providerInput).toMatch(/496 100$/);
    expect(providerOutput).toMatch(/^M 504 100/);
    expect(providerOutput).toMatch(/504 300$/);
    expect(makeTokenPath(200, 500, 1000, 600, true, -4)).toMatch(/^M 196 500.*496 300$/);
    expect(makeTokenPath(200, 500, 1000, 600, false, 4)).toMatch(/^M 504 300.*204 500$/);
  });
});

describe("live token progress (display-only)", () => {
  it("estimates only received Responses deltas and lets exact terminal usage replace estimates", () => {
    const update = createLiveTokenProgress(100000);
    expect(update(null)).toEqual({ inputTokens: 100000, outputTokens: 0, estimated: true });
    expect(update({ type: "response.output_text.delta", delta: "abcdefgh" }).outputTokens).toBe(2);
    expect(update({ type: "response.function_call_arguments.delta", delta: "ijklmnop" }).outputTokens).toBe(4);
    expect(update({ type: "response.output_text.done", text: "abcdefgh" }).outputTokens).toBe(4);
    expect(update({ type: "response.completed", response: { usage: { input_tokens: 1234, output_tokens: 3 } } })).toEqual({ inputTokens: 1234, outputTokens: 3, estimated: false });
  });

  it("counts OpenAI text, reasoning and tool deltas without retaining content", () => {
    const update = createLiveTokenProgress(20);
    expect(update({ choices: [{ delta: { content: "abcd", reasoning_content: "efgh", tool_calls: [{ function: { arguments: "ijkl" } }] } }] })).toEqual({ inputTokens: 20, outputTokens: 3, estimated: true });
    expect(update({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } })).toEqual({ inputTokens: 12, outputTokens: 5, estimated: false });
  });

  it("includes Claude cache in input and merges split usage", () => {
    const update = createLiveTokenProgress(900);
    expect(update({ type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 50, output_tokens: 1 } } })).toEqual({ inputTokens: 350, outputTokens: 1, estimated: false });
    expect(update({ type: "content_block_delta", delta: { text: "abcdefgh" } }).outputTokens).toBe(3);
    expect(update({ type: "message_delta", usage: { output_tokens: 10 } })).toEqual({ inputTokens: 350, outputTokens: 10, estimated: false });
  });

  it("counts nested Gemini streamed text and no activity from metadata alone", () => {
    const update = createLiveTokenProgress(40);
    expect(update({ response: { candidates: [{ content: { parts: [{ text: "abcdefgh" }] } }] } }).outputTokens).toBe(2);
    expect(update({ type: "ping" }).outputTokens).toBe(2);
  });
});
