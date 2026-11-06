import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import { DEVIN } from "../../open-sse/config/devin.js";
import { decodeProtobuf, encodeBytesField as b, encodeVarintField as v, encodeDoubleField as d } from "../../open-sse/shared/devin/protobuf.js";
import { buildDevinClientMetadata, buildDevinHeaders, generateDevinFingerprint, parseDevinFrame, parseDevinTrailer, readConnectFrames, wrapConnectEnvelope as frame } from "../../open-sse/shared/devin/protocol.js";
import { buildDevinChatRequest, buildDevinMessagesRequest, encodeDevinToolId, decodeDevinToolId, resolveDevinModelUid } from "../../open-sse/shared/devin/request.js";
import { devinCompletion, devinOpenAIChunks } from "../../open-sse/shared/devin/response.js";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.js";

const concat = (...bytes) => Buffer.concat(bytes);
const fields = bytes => decodeProtobuf(bytes);
const get = (bytes, number) => fields(bytes).find(field => field.number === number)?.value;
const text = (bytes, number) => get(bytes, number)?.toString();
function body(bytes, split = bytes.length) {
  let position = 0;
  return new ReadableStream({ pull(controller) {
    if (position >= bytes.length) return controller.close();
    controller.enqueue(bytes.subarray(position, position + split));
    position += split;
  } });
}
const request = (extra = {}, model = "swe-2-high") => buildDevinChatRequest({ model, sessionToken: "fake-token", deviceSeed: "seed", body: { messages: [{ role: "user", content: "hello" }], ...extra } });
const collect = async stream => { const frames = []; for await (const f of readConnectFrames(stream)) frames.push(f); return frames; };
const eosFixture = () => frame(Buffer.from("{}"), DEVIN.flags.end);

describe("Devin protobuf and Connect wire", () => {
  it("round-trips varints, opaque bytes, double and skips unknown fixed32", () => {
    const wire = concat(v(1, 18446744073709551615n), b(2, "你好"), d(3, 0.5), Buffer.from([0x25, 1, 2, 3, 4]));
    const result = fields(wire);
    expect(result.map(f => f.wireType)).toEqual([0, 2, 1, 5]);
    expect(result[0].value).toBe(18446744073709551615n);
    expect(result[1].value.toString()).toBe("你好");
    expect(result[2].value.readDoubleLE()).toBe(0.5);
  });
  it.each([
    [0], [0x08, 0x80], [0x0a, 0x05, 1], [0x09, 1], [0x0b],
    [0x08, ...Array(9).fill(255), 2], [0x80, 0x80, 0x80, 0x80, 0x10, 0],
  ])("rejects malformed protobuf %j", (...bytes) => expect(() => fields(Buffer.from(bytes))).toThrow());
  it("bounds total bytes and field count", () => {
    expect(() => decodeProtobuf(b(1, "hello"), { maxBytes: 2 })).toThrow(/size limit/);
    expect(() => decodeProtobuf(concat(v(1, 1), v(1, 2)), { maxFields: 1 })).toThrow(/field count/);
    expect(() => v(1, Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });
  it("uses exact metadata and native Basic auth", () => {
    const metadata = buildDevinClientMetadata({ sessionToken: "secret", deviceSeed: "seed", osName: "darwin" });
    expect(text(metadata, 1)).toBe("devin-cli");
    expect(text(metadata, 2)).toBe("3000.11.3");
    expect(text(metadata, 3)).toBe("secret");
    expect(text(metadata, 4)).toBe("en");
    expect(text(metadata, 5)).toBe("darwin");
    expect(text(metadata, 12)).toBe("chisel");
    expect(text(metadata, 28)).toBe("chisel");
    expect(generateDevinFingerprint("seed")).toMatch(/^[\da-f]{732}$/);
    expect(generateDevinFingerprint()).not.toBe(generateDevinFingerprint());
    expect(buildDevinHeaders("secret").Authorization).toBe("Basic secret");
    expect(buildDevinHeaders("secret")["Sentry-Trace"]).toMatch(/^[\da-f]{32}-[\da-f]{16}-1$/);
    expect(buildDevinHeaders("secret", { unary: true })["Sentry-Trace"]).toBeUndefined();
  });
  it("reads one-byte splits, gzip data, compressed EOS", async () => {
    const wire = concat(frame(b(3, "hello")), frame(gzipSync(b(9, "think")), 1), frame(gzipSync(Buffer.from("{}")), 3));
    const result = await collect(body(wire, 1));
    expect(result.map(f => f.flag)).toEqual([0, 1, 3]);
    expect(parseDevinFrame(result[1].payload).thinkingBytes.toString()).toBe("think");
  });
  it.each([Buffer.from([4, 0, 0, 0, 0]), Buffer.from([0, 1, 0, 0, 1]), frame(Buffer.from("not gzip"), 1)])("rejects invalid frames", async wire => {
    await expect(collect(body(wire))).rejects.toThrow();
  });
  it("bounds decompressed bytes", async () => {
    const wire = frame(gzipSync(Buffer.alloc(1000)), 1);
    await expect((async () => { for await (const f of readConnectFrames(body(wire), { maxDecompressedBytes: 100 })) void f; })()).rejects.toThrow(/gzip/);
  });
  it.each([Buffer.alloc(0), Buffer.from([0, 0]), concat(frame(b(3, "partial")), Buffer.from([0, 0, 0, 0, 2, 0]))])("rejects unexpected EOF", async wire => {
    await expect(collect(body(wire, 1))).rejects.toThrow(/EOF/);
  });
  it.each([
    ["unauthenticated", "expired", 401], ["resource_exhausted", "quota", 429],
    ["permission_denied", "high demand", 429], ["failed_precondition", "ACU limit", 429],
    ["unavailable", "busy", 503], ["invalid_argument", "internal error", 502],
  ])("preserves Connect terminal error %s", (code, message, status) => {
    try { parseDevinTrailer(Buffer.from(JSON.stringify({ error: { code, message } }))); throw new Error("missing error"); }
    catch (error) { expect(error.code).toBe(code); expect(error.status).toBe(status); }
  });
  it("rejects malformed trailers instead of accepting success", () => {
    for (const trailer of ["", "[", "null", "[]"]) expect(() => parseDevinTrailer(Buffer.from(trailer))).toThrow();
    expect(parseDevinTrailer(Buffer.from('{"metadata":{}}'))).toEqual({ metadata: {} });
  });
  it("cancels a pending upstream read on abort", async () => {
    let cancelled = false;
    const upstream = new ReadableStream({ cancel() { cancelled = true; } });
    const controller = new AbortController();
    const iterator = readConnectFrames(upstream, { signal: controller.signal });
    const pending = iterator.next();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
  });
});

describe("OpenAI to Devin request", () => {
  it("encodes prompts, function schemas, tools/results, images and reasoning", () => {
    const wire = request({ temperature: 0, max_tokens: 2048, messages: [
      { role: "system", content: "system" }, { role: "developer", content: "developer" },
      { role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } }] },
      { role: "assistant", content: "", reasoning_content: "thought", reasoning_signature: "c2ln", reasoning_signature_type: "anthropic", tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: '{"q":1}' } }] },
      { role: "tool", tool_call_id: "call-1", content: "result" },
    ], tools: [{ type: "function", function: { name: "lookup", description: "Find", parameters: { type: "object" } } }] });
    expect(text(wire, 2)).toBeUndefined();
    const prompts = fields(wire).filter(f => f.number === 3).map(f => f.value);
    expect(prompts.map(p => Number(get(p, 2)))).toEqual([1, 2, 4]);
    expect(text(get(prompts[0], 10), 1)).toBe("aGk=");
    expect(text(prompts[1], 11)).toBe("thought");
    expect(get(prompts[1], 12)).toBeUndefined();
    expect(text(prompts[1], 18)).toBeUndefined();
    expect(text(prompts[0], 3)).toContain("system\n\ndeveloper");
    expect(text(get(prompts[1], 6), 1)).toBe("call-1");
    expect(text(prompts[2], 7)).toBe("call-1");
    expect(text(get(wire, 10), 3)).toBe('{"type":"object"}');
    expect(get(get(wire, 8), 5).readDoubleLE()).toBe(1e-6);
    expect(get(get(wire, 8), 2)).toBe(2048n);
    expect(text(wire, 21)).toBe("swe-2-high");
  });
  it("keeps wire UIDs opaque; catalog resolver selects effort outside builder", () => {
    expect(resolveDevinModelUid("MODEL_NEW_123", { reasoning_effort: "high" })).toBe("MODEL_NEW_123");
    expect(resolveDevinModelUid("devin/swe-2-high")).toBe("swe-2-high");
  });
  it("does not invent session flags absent from the Magpie request", () => {
    const wire = request({ session_id: "stable" });
    expect(get(wire, 15)).toBeUndefined();
    expect(get(wire, 16)).toBeUndefined();
  });
  it.each(["required", { type: "function", function: { name: "lookup" } }])("adapts requested tool choice and serial tools as instructions without fake wire fields", choice => {
    const wire = request({ tool_choice: choice, parallel_tool_calls: false, tools: [{ type: "function", function: { name: "lookup", strict: true, parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"], additionalProperties: false } } }] });
    const prompt = text(fields(wire).find(f => f.number === 3).value, 3);
    expect(prompt).toContain("must call");
    expect(prompt).toContain("at most one tool");
    expect(JSON.parse(text(get(wire, 10), 3)).additionalProperties).toBe(false);
  });
  it("puts structured output and tool descriptions ahead of first user prompt", () => {
    const schema = { type: "object", properties: { answer: { type: "string" } } };
    const wire = request({ response_format: { type: "json_schema", json_schema: { strict: true, schema } }, tools: [{ type: "function", function: { name: "lookup", description: "Find things", parameters: { type: "object" } } }] });
    const prompt = text(get(wire, 3), 3);
    expect(prompt).toContain(JSON.stringify(schema));
    expect(prompt).toContain('<tool name="lookup">\nFind things');
    expect(text(get(wire, 10), 2)).toContain("Described under");
  });
  it("folds root unions including local refs and normalizes Gemini schemas recursively without mutating input", () => {
    const parameters = { oneOf: [{ $ref: "#/$defs/a" }, { type: "object", properties: { q: { type: ["string", "null"] }, list: { type: "array" } }, required: ["q"] }], $defs: { a: { type: "object", properties: { q: { type: ["string", "null"] } }, required: ["q"] } } };
    const original = structuredClone(parameters);
    const wire = request({ tools: [{ type: "function", function: { name: "lookup", parameters } }] }, "gemini-4-argon-high");
    const schema = JSON.parse(text(get(wire, 10), 3));
    expect(schema.type).toBe("object");
    expect(schema.oneOf).toBeUndefined();
    expect(schema.required).toEqual(["q"]);
    expect(schema.properties.q).toEqual({ type: "string", nullable: true });
    expect(schema.properties.list.items).toEqual({});
    expect(parameters).toEqual(original);
  });
  it("moves gateway-forwarded images back onto their tool result, leaving user images separate", () => {
    const wire = request({ messages: [
      { role: "user", content: "look" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "shot", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "[The tool returned an image; it follows in the next message.]" },
      { role: "user", content: [{ type: "text", text: "[From the result of shot (tool call c1):]" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }, { type: "text", text: "own words" }, { type: "image_url", image_url: { url: "data:image/gif;base64,BBBB" } }] },
    ] });
    const prompts = fields(wire).filter(f => f.number === 3).map(f => f.value);
    expect(prompts.map(p => Number(get(p, 2)))).toEqual([1, 2, 4, 1]);
    expect(text(prompts[2], 3)).toBe("(no output)");
    expect(text(get(prompts[2], 10), 1)).toBe("AAAA");
    expect(text(prompts[3], 3)).toBe("own words");
    expect(text(get(prompts[3], 10), 1)).toBe("BBBB");
  });
  it("keeps inline tool images and omits remote URL images as Magpie does, with no fetch", () => {
    const wire = request({ messages: [
      { role: "user", content: "look" },
      { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "shot", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: [{ type: "text", text: "done" }, { type: "image_url", image_url: { url: "https://example.com/x.png" } }, { type: "image_url", image_url: { url: "data:image/webp;base64,AAAA" } }] },
    ] });
    const prompt = fields(wire).filter(f => f.number === 3).at(-1).value;
    expect(fields(prompt).filter(f => f.number === 10)).toHaveLength(1);
    expect(text(get(prompt, 10), 2)).toBe("image/webp");
  });
  it("joins split assistant calls and fills interrupted results; skips orphan/duplicate results", () => {
    const call = id => ({ id, type: "function", function: { name: "lookup", arguments: {} } });
    const wire = request({ messages: [
      { role: "user", content: "go" }, { role: "assistant", reasoning: "one", tool_calls: [call("a")] },
      { role: "assistant", reasoning: "two", tool_calls: [call("b")] },
      { role: "tool", tool_call_id: "a", content: "ok" }, { role: "tool", tool_call_id: "a", content: "duplicate" },
      { role: "tool", tool_call_id: "orphan", content: "orphan" }, { role: "user", content: "continue" },
    ] });
    const prompts = fields(wire).filter(f => f.number === 3).map(f => f.value);
    expect(prompts.map(p => Number(get(p, 2)))).toEqual([1, 2, 4, 4, 1]);
    expect(text(prompts[1], 11)).toBe("one\n\ntwo");
    expect(fields(prompts[1]).filter(f => f.number === 6)).toHaveLength(2);
    expect(text(prompts[3], 7)).toBe("b");
    expect(text(prompts[3], 3)).toBe(DEVIN.noResult);
  });
  it("keeps Claude unsigned reasoning out and sends signed thinking as its original string", () => {
    const messages = [{ role: "user", content: "go" }, { role: "assistant", content: "answer", reasoning_content: "thought" }];
    let wire = request({ messages }, "claude-opus-5-5-high");
    let assistant = fields(wire).filter(f => f.number === 3).map(f => f.value).find(p => get(p, 2) === 2n);
    expect(get(assistant, 11)).toBeUndefined();
    messages[1].reasoning_signature = "original-signature=";
    wire = request({ messages }, "claude-opus-5-5-high");
    assistant = fields(wire).filter(f => f.number === 3).map(f => f.value).find(p => get(p, 2) === 2n);
    expect(text(assistant, 11)).toBe("thought");
    expect(text(assistant, 12)).toBe("original-signature=");
  });
  it("preserves native Messages cache boundaries, signed thinking and error tool images", () => {
    const wire = buildDevinMessagesRequest({ model: "claude-opus-5-5-high", sessionToken: "fake", body: {
      system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "go" }, { role: "assistant", content: [{ type: "thinking", thinking: "thought", signature: "native-sig" }, { type: "tool_use", id: "a", name: "lookup", input: {}, cache_control: { type: "ephemeral" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "a", is_error: true, content: [{ type: "text", text: "failed" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }], cache_control: { type: "ephemeral" } }] }],
    } });
    const prompts = fields(wire).filter(f => f.number === 3).map(f => f.value);
    expect(prompts.map(p => Number(get(p, 2)))).toEqual([1, 1, 2, 4]);
    expect(get(get(prompts[0], 8), 1)).toBe(1n);
    expect(text(prompts[2], 12)).toBe("native-sig");
    expect(get(get(prompts[2], 8), 1)).toBe(1n);
    expect(text(prompts[3], 3)).toBe("Error: failed");
    expect(text(get(prompts[3], 10), 1)).toBe("AAAA");
    expect(get(get(prompts[3], 8), 1)).toBe(1n);
  });
  it("tool IDs use reversible safe encoding including literal dv_ prefix", () => {
    for (const id of ["Bash:0#abc", "dv_", "dv_abc", "call_safe-1"]) {
      const encoded = encodeDevinToolId(id);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeDevinToolId(encoded)).toBe(id);
    }
    const raw = "Bash:0#abc";
    const encoded = encodeDevinToolId(raw);
    const wire = request({ messages: [{ role: "user", content: "go" }, { role: "assistant", tool_calls: [{ id: encoded, type: "function", function: { name: "Bash", arguments: "{}" } }] }, { role: "tool", tool_call_id: encoded, content: "ok" }] });
    const prompts = fields(wire).filter(f => f.number === 3).map(f => f.value);
    expect(text(get(prompts[1], 6), 1)).toBe(raw);
    expect(text(prompts[2], 7)).toBe(raw);
  });
  it("implements tool_choice none without transmitting tool definitions", () => {
    const wire = request({ tool_choice: "none", tools: [{ type: "function", function: { name: "x" } }] });
    expect(get(wire, 10)).toBeUndefined();
  });
});

describe("Devin to OpenAI response", () => {
  it("handles split UTF-8 content/reasoning and tool argument deltas", async () => {
    const utf8 = Buffer.from("你好");
    const wire = concat(
      frame(concat(b(3, utf8.subarray(0, 2)), b(9, utf8.subarray(0, 1)))),
      frame(concat(b(3, utf8.subarray(2)), b(9, utf8.subarray(1)), b(10, "sig"), b(21, "anthropic"))),
      frame(b(6, concat(b(1, "call-1"), b(2, "lookup"), b(3, '{"q":')))),
      frame(b(6, b(3, "1}"))), frame(v(5, 10)),
      frame(b(7, concat(v(2, 10), v(3, 5), v(4, 3), v(5, 20)))), frame(Buffer.from("{}"), 2),
    );
    const response = await devinCompletion(body(wire, 2), "swe-2-high");
    expect(response.choices[0].message).toEqual({ role: "assistant", content: "你好", reasoning_content: "你好", reasoning_signature: "sig", reasoning_signature_type: "anthropic", tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: '{"q":1}' } }] });
    expect(response.choices[0].finish_reason).toBe("tool_calls");
    expect(response.usage).toEqual({ prompt_tokens: 33, completion_tokens: 5, total_tokens: 38, prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 3 } });
  });
  it.each([[1, "length"], [3, "length"], [11, "content_filter"], [2, "stop"], [4, "stop"]])("maps native stop reason %i", async (reason, expected) => {
    const result = await devinCompletion(body(concat(frame(concat(b(3, "text"), v(5, reason))), frame(Buffer.from("{}"), 2))), "m");
    expect(result.choices[0].finish_reason).toBe(expected);
  });
  it("decodes tool arguments split inside UTF-8 and preserves interleaved call indexes", async () => {
    const args = Buffer.from('{"q":"你好"}');
    const split = args.indexOf(Buffer.from("你")) + 1;
    const wire = concat(
      frame(b(6, concat(b(1, "one"), b(2, "first"), b(3, args.subarray(0, split))))),
      frame(b(6, concat(b(1, "two"), b(2, "second"), b(3, "{}")))),
      frame(b(6, concat(b(1, "one"), b(3, args.subarray(split))))), eosFixture(),
    );
    const result = await devinCompletion(body(wire, 1), "m");
    expect(result.choices[0].message.tool_calls).toEqual([
      { id: "one", type: "function", function: { name: "first", arguments: '{"q":"你好"}' } },
      { id: "two", type: "function", function: { name: "second", arguments: "{}" } },
    ]);
  });
  it("preserves early tool arguments when Claude streaming receives delayed identity", async () => {
    const wire = concat(frame(b(6, b(3, '{"q":'))), frame(b(6, b(1, "late"))), frame(b(6, concat(b(2, "lookup"), b(3, '"ok"}')))), eosFixture());
    const state = { provider: "devin", toolCalls: new Map(), messageStartSent: false, nextBlockIndex: 0 };
    const events = [];
    for await (const chunk of devinOpenAIChunks(body(wire), "swe-2-high")) events.push(...(openaiToClaudeResponse(chunk, state) || []));
    expect(events.find(e => e.content_block?.type === "tool_use").content_block).toMatchObject({ id: "late", name: "lookup" });
    const argumentsText = events.filter(e => e.delta?.type === "input_json_delta").map(e => e.delta.partial_json).join("");
    expect(JSON.parse(argumentsText)).toEqual({ q: "ok" });
  });
  it("accepts delayed tool identity but rejects incomplete identity and broken UTF-8", async () => {
    const wire = concat(frame(b(6, b(3, "{}"))), frame(b(6, concat(b(1, "late"), b(2, "lookup")))), eosFixture());
    expect((await devinCompletion(body(wire), "m")).choices[0].message.tool_calls[0].id).toBe("late");
    await expect(devinCompletion(body(concat(frame(b(6, b(3, "{}"))), eosFixture())), "m")).rejects.toThrow(/empty reply|incomplete tool/);
    await expect(devinCompletion(body(concat(frame(b(3, Buffer.from([0xe4]))), eosFixture())), "m")).rejects.toThrow();
  });
  it("propagates late terminal error instead of returning partial completion", async () => {
    const wire = concat(frame(b(3, "partial")), frame(Buffer.from('{"error":{"code":"resource_exhausted","message":"quota"}}'), 2));
    await expect(devinCompletion(body(wire), "m")).rejects.toMatchObject({ status: 429, code: "resource_exhausted" });
  });
  it("does not swallow malformed nested tool protobuf or usage upstream error", async () => {
    expect(() => parseDevinFrame(b(6, Buffer.from([10, 10, 1])))).toThrow();
    const wire = concat(frame(b(7, v(6, 403))), frame(Buffer.from("{}"), 2));
    await expect(devinCompletion(body(wire), "m")).rejects.toMatchObject({ status: 403 });
  });
  it("does not claim custom tool calls are function calls", () => {
    expect(() => parseDevinFrame(b(6, concat(b(1, "id"), v(6, 1))))).toThrow(/custom tool/);
  });
  it("supports bounded response dimension group usage fallback", async () => {
    const value = Buffer.alloc(5); value[0] = 0x15; value.writeFloatLE(12, 1);
    const group = concat(b(1, "Token Usage"), b(2, concat(b(5, "input_tokens"), b(4, value))));
    const wire = concat(frame(concat(b(3, "text"), b(28, group))), frame(Buffer.from("{}"), 2));
    expect((await devinCompletion(body(wire), "m")).usage.prompt_tokens).toBe(12);
  });
});
