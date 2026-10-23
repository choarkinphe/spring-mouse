import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => fetchMock(...args) }));
vi.mock("../../src/lib/mouse/tunnel.js", () => ({ dispatchMouseTask: vi.fn() }));

import { WorkBuddyExecutor } from "../../open-sse/executors/workbuddy.js";
import { CodeBuddyBaseExecutor } from "../../open-sse/executors/codebuddy-base.js";
import { WORKBUDDY_SITES, getWorkBuddySite, buildWorkBuddyHeaders } from "../../open-sse/config/workbuddy.js";

function credentials(provider, metadata = {}) {
  return {
    accessToken: `test-${provider}-token`,
    providerSpecificData: {
      workbuddyProduct: provider, workbuddyOrigin: getWorkBuddySite(provider).origin,
      workbuddyPlatform: getWorkBuddySite(provider).platform, workbuddyContract: "0.1.30",
      domain: getWorkBuddySite(provider).domain, tokenType: "Bearer", codebuddyUid: "test-user", ...metadata,
    },
  };
}
const providers = Object.keys(WORKBUDDY_SITES);
const frame = delta => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`;
afterEach(() => { fetchMock.mockReset(); vi.useRealTimers(); });

describe("trusted WorkBuddy sites and headers", () => {
  it("has separate domestic/international origins and platforms", () => {
    expect(getWorkBuddySite("workbuddy")).toMatchObject({ origin: "https://copilot.tencent.com", platform: "workbuddy" });
    expect(getWorkBuddySite("workbuddy-ai")).toMatchObject({ origin: "https://www.workbuddy.ai", platform: "workbuddy-ai" });
    for (const id of ["codebuddy-cn", "codebuddy-intl", "openai", "__proto__", "constructor"]) {
      expect(() => getWorkBuddySite(id)).toThrow("Unsupported WorkBuddy provider");
      expect(() => new WorkBuddyExecutor(id)).toThrow();
    }
    expect(Object.isFrozen(WORKBUDDY_SITES)).toBe(true);
    expect(Object.isFrozen(getWorkBuddySite("workbuddy"))).toBe(true);
  });

  it.each(providers)("builds %s auth from only selected bound credentials", provider => {
    const selected = {
      ...credentials(provider),
      apiKey: "wrong-api-key",
      rawHeaders: { Authorization: "Bearer hostile", Cookie: "session=hostile", "X-User-Id": "hostile", "User-Agent": "WorkBuddy/5.5.6", "X-IDE-Type": "WorkBuddy", "X-Domain": "evil.test", "X-Tenant-Id": "hostile", "X-Request-ID": "hostile" },
      runtimeTransport: { headers: { Authorization: "Bearer runtime", "X-IDE-Name": "WorkBuddy" } },
    };
    const headers = buildWorkBuddyHeaders(provider, selected, { stream: true });
    expect(headers).toMatchObject({ Authorization: `Bearer test-${provider}-token`, "X-User-Id": "test-user", "User-Agent": "Spring-Mouse", "X-Domain": getWorkBuddySite(provider).domain, "X-Product": "SaaS", Accept: "text/event-stream" });
    for (const key of ["Cookie", "X-IDE-Name", "X-IDE-Type", "X-IDE-Version", "X-Agent-Type", "X-Agent-Intent", "X-Tenant-Id"]) expect(headers[key]).toBeUndefined();
    expect(Object.values(headers)).not.toContain("hostile");
    expect(headers["X-Request-ID"]).toMatch(/^[\da-f-]{36}$/);
    expect(headers["X-Conversation-Message-ID"]).toBe(headers["X-Request-ID"]);
    expect(buildWorkBuddyHeaders(provider, selected, { stream: true })["X-Request-ID"]).not.toBe(headers["X-Request-ID"]);
  });

  it("permits unauthenticated OAuth setup without inventing user identity", () => {
    const headers = buildWorkBuddyHeaders("workbuddy");
    expect(headers.Accept).toBe("application/json");
    expect(headers.Authorization).toBeUndefined();
    expect(headers["X-User-Id"]).toBeUndefined();
    expect(buildWorkBuddyHeaders("workbuddy", { apiKey: "not-an-oauth-token" }).Authorization).toBeUndefined();
  });

  it.each(providers)("rejects missing or wrong %s credential bindings", provider => {
    const other = providers.find(id => id !== provider);
    expect(() => buildWorkBuddyHeaders(provider, credentials(other))).toThrow("workbuddyProduct mismatch");
    expect(() => buildWorkBuddyHeaders(provider, { accessToken: "test" })).toThrow("binding");
    for (const key of ["workbuddyProduct", "workbuddyOrigin", "workbuddyPlatform", "workbuddyContract", "domain", "codebuddyUid"]) {
      const selected = credentials(provider);
      delete selected.providerSpecificData[key];
      expect(() => buildWorkBuddyHeaders(provider, selected)).toThrow("binding");
    }
    for (const [key, value] of [["workbuddyPlatform", "ide"], ["workbuddyContract", "unknown"], ["tokenType", "Basic"]]) {
      expect(() => buildWorkBuddyHeaders(provider, credentials(provider, { [key]: value }))).toThrow();
    }
    for (const origin of ["https://evil.test", "http://copilot.tencent.com", `${getWorkBuddySite(provider).origin}/evil`, `${getWorkBuddySite(provider).origin}.evil.test`]) {
      expect(() => buildWorkBuddyHeaders(provider, credentials(provider, { workbuddyOrigin: origin }))).toThrow("workbuddyOrigin mismatch");
    }
    expect(() => buildWorkBuddyHeaders(provider, credentials(provider, { domain: "evil.test" }))).toThrow("domain mismatch");
    expect(() => buildWorkBuddyHeaders(provider, credentials(provider, { domain: getWorkBuddySite(provider).domain }))).not.toThrow();
  });

  it.each(["accessToken", "codebuddyUid", "enterpriseId"])("rejects control characters in %s", key => {
    const selected = credentials("workbuddy", { enterpriseId: "team", tenantVerified: true });
    if (key === "accessToken") selected.accessToken = "test\r\nInjected: value";
    else selected.providerSpecificData[key] = "test\r\nInjected: value";
    expect(() => buildWorkBuddyHeaders("workbuddy", selected)).toThrow("Invalid WorkBuddy");
  });

  it.each(providers)("sends only verified, account-bound %s tenant context", provider => {
    expect(() => buildWorkBuddyHeaders(provider, credentials(provider, { enterpriseId: "team" }))).toThrow("verified");
    expect(() => buildWorkBuddyHeaders(provider, credentials(provider, { tenantId: "team", tenantVerified: true }))).toThrow("enterpriseId");
    expect(() => buildWorkBuddyHeaders(provider, credentials(provider, { enterpriseId: "team", tenantId: "other", tenantVerified: true }))).toThrow("mismatch");
    expect(() => buildWorkBuddyHeaders(provider, credentials(provider, { enterpriseId: "team", tenantVerified: true, codebuddyUid: undefined }))).toThrow("UID binding");
    expect(buildWorkBuddyHeaders(provider, credentials(provider, { enterpriseId: "team", tenantVerified: true }))).toMatchObject({ "X-Enterprise-Id": "team", "X-Tenant-Id": "team" });
    expect(buildWorkBuddyHeaders(provider, credentials(provider, { enterpriseId: "team", tenantId: "team", tenantVerified: true }))).toMatchObject({ "X-Enterprise-Id": "team", "X-Tenant-Id": "team" });
  });
});

describe.each(providers)("%s normal request transport", provider => {
  const executor = new WorkBuddyExecutor(provider);
  const transform = body => executor.transformRequest("test-model", body, false, credentials(provider));

  it("extends the first-output executor and cannot redirect a selected token", () => {
    expect(executor).toBeInstanceOf(CodeBuddyBaseExecutor);
    expect(executor.provider).toBe(provider);
    expect(executor.buildUrl("test", false, 0, { runtimeTransport: { baseUrl: "https://evil.test" }, providerSpecificData: { baseUrl: "https://evil.test" } })).toBe(`${getWorkBuddySite(provider).origin}/v2/chat/completions`);
    expect(executor.buildHeaders(credentials(provider), false).Accept).toBe("text/event-stream");
    expect(() => executor.buildHeaders({ apiKey: "not-oauth" })).toThrow("OAuth accessToken");
  });

  it("preserves every instruction in order, mapping developer only to system", () => {
    const content = [{ type: "text", text: "A typed instruction", cache_control: { type: "ephemeral" } }];
    const messages = [
      { role: "system", content: "You are Claude Code, Anthropic's official CLI. " + "all instructions remain. ".repeat(200) },
      { role: "developer", content },
      { role: "user", content: "Keep every user instruction" },
      { role: "system", content: "Later system instruction" },
      { role: "developer", content: "Later developer instruction" },
    ];
    const body = { messages, stream: false };
    const before = structuredClone(body);
    const out = transform(body);
    expect(out.messages.map(m => m.role)).toEqual(["system", "system", "user", "system", "system"]);
    expect(out.messages[0].content).toBe(messages[0].content);
    expect(out.messages[1].content).toEqual(content);
    expect(out.messages[2].content).toEqual([{ type: "text", text: "Keep every user instruction" }]);
    expect(out.messages[3].content).toBe(messages[3].content);
    expect(out.messages[4].content).toBe(messages[4].content);
    expect(out.stream).toBe(true);
    expect(body).toEqual(before);
  });

  it("adds a neutral prompt only when no system/developer exists", () => {
    expect(transform({ messages: [{ role: "user", content: "hello" }] }).messages[0]).toEqual({ role: "system", content: "You are a helpful assistant." });
    expect(transform({ messages: [{ role: "developer", content: "Keep me" }] }).messages).toEqual([{ role: "system", content: "Keep me" }]);
    expect(transform({ messages: [{ role: "user", content: "hello" }, { role: "system", content: "Keep my position" }] }).messages).toHaveLength(2);
  });

  it("does not rewrite user images, tool results, assistant/tool-call blocks", () => {
    const messages = [
      { role: "system", content: "Do not remove" },
      { role: "user", content: [{ type: "text", text: "Inspect" }, { type: "image_url", image_url: { url: "data:image/png;base64,TEST", detail: "high" } }] },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"test"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "error trace: retain this", is_error: true }] },
    ];
    const tools = [{ type: "function", function: { name: "read", parameters: { type: "object" } } }];
    expect(transform({ messages, tools })).toMatchObject({ messages, tools });
  });

  it("normalizes only named tool_choice through the shared helper", () => {
    const read = { type: "function", function: { name: "read", parameters: { type: "object" } } };
    const write = { type: "function", function: { name: "write" } };
    expect(transform({ tools: [read, write], tool_choice: { type: "function", function: { name: "read" } } })).toMatchObject({ tools: [read], tool_choice: "required" });
    expect(transform({ tools: [read, write], tool_choice: "auto" })).toMatchObject({ tools: [read, write], tool_choice: "auto" });
  });

  it("uses max_tokens when explicit and otherwise translates max_completion_tokens", () => {
    const body = { max_tokens: 42, max_completion_tokens: 99 };
    const out = transform(body);
    expect(out.max_tokens).toBe(42);
    expect(out.max_completion_tokens).toBeUndefined();
    expect(transform({ max_completion_tokens: 99 }).max_tokens).toBe(99);
    expect(body).toEqual({ max_tokens: 42, max_completion_tokens: 99 });
  });

  it("keeps reasoning opt-in without stripping instructions", () => {
    expect(transform({}).reasoning_effort).toBeUndefined();
    expect(transform({}).reasoning_summary).toBeUndefined();
    expect(transform({ reasoning_effort: "high" })).toMatchObject({ reasoning_effort: "high", reasoning_summary: "auto" });
    expect(transform({ reasoning_effort: "high", reasoning_summary: "detailed" }).reasoning_summary).toBe("detailed");
    for (const effort of ["none", "off"]) {
      const out = transform({ reasoning_effort: effort, reasoning_summary: "auto" });
      expect(out.reasoning_effort).toBeUndefined();
      expect(out.reasoning_summary).toBeUndefined();
    }
  });

  it("preserves raw 11128 status/body and never retries with a changed prompt", async () => {
    const raw = JSON.stringify({ code: 11128, msg: "request rejected", details: { reason: "upstream evidence" } });
    fetchMock.mockResolvedValue(new Response(raw, { status: 400, headers: { "content-type": "application/json" } }));
    const body = { messages: [{ role: "system", content: "Original instruction" }, { role: "user", content: "Original question" }] };
    const result = await executor.execute({ model: "test-model", body, stream: false, credentials: credentials(provider) });
    expect(result.response.status).toBe(400);
    expect(await result.response.text()).toBe(raw);
    expect(executor.parseError({ status: 400 }, raw)).toEqual({ status: 400, message: raw });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ stream: true, messages: [{ role: "system", content: "Original instruction" }, { role: "user", content: [{ type: "text", text: "Original question" }] }] });
  });

  it("reactively refreshes the selected provider through its bound refresh service", async () => {
    const selected = { ...credentials(provider), refreshToken: `refresh-${provider}` };
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 0, data: {
      accessToken: `renewed-${provider}`, refreshToken: `rotated-${provider}`, expiresIn: 3600,
      domain: getWorkBuddySite(provider).domain, tokenType: "Bearer",
    } }), { headers: { "content-type": "application/json" } }));
    const proxy = { connectionProxyEnabled: false };
    const result = await executor.refreshCredentials(selected, undefined, proxy);
    expect(result).toMatchObject({ accessToken: `renewed-${provider}`, refreshToken: `rotated-${provider}`, providerSpecificData: selected.providerSpecificData });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options, passedProxy] = fetchMock.mock.calls[0];
    expect(url).toBe(getWorkBuddySite(provider).refreshUrl);
    expect(options.headers["X-Refresh-Token"]).toBe(`refresh-${provider}`);
    expect(options.headers.Authorization).toBeUndefined();
    expect(options.headers["X-Domain"]).toBe(getWorkBuddySite(provider).domain);
    expect(passedProxy).toBe(proxy);
  });

  it("reuses CodeBuddy quota hints without changing the raw error", () => {
    const raw = JSON.stringify({ code: 14003, msg: "frequency limit" });
    expect(executor.parseError({ status: 429 }, raw)).toMatchObject({ status: 429, message: raw, retryAfterMs: expect.any(Number) });
  });

  it("uses the first-output gate and replays upstream bytes even for JSON clients", async () => {
    const prefix = ": heartbeat\n\n" + frame({ role: "assistant" });
    let controller;
    const stream = new ReadableStream({ start(c) { controller = c; c.enqueue(new TextEncoder().encode(prefix)); } });
    fetchMock.mockResolvedValue(new Response(stream, { headers: { "content-type": "text/event-stream" } }));
    let settled = false;
    const work = executor.execute({ model: "test-model", body: { messages: [{ role: "user", content: "test" }] }, stream: false, credentials: credentials(provider), overloadDeadline: Date.now() + 5000 }).then(result => { settled = true; return result; });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    const tail = frame({ content: "hello" }) + "data: [DONE]\n\n";
    controller.enqueue(new TextEncoder().encode(tail));
    controller.close();
    const result = await work;
    expect(await result.response.text()).toBe(prefix + tail);
    expect(result.timing.firstOutputWaitMs).toBeGreaterThanOrEqual(0);
  });
});
