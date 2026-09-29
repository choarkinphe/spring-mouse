// Lifecycle integration for routing telemetry in src/sse/handlers/chat.js.
//
// These pin the contract the durable writer (runtime/routing-writer.mjs) and the
// shared normalizer (src/shared/utils/routingTelemetry.js) depend on:
//   - exactly one request upsert + one request complete per external handleChat
//   - one routingRequestId per request; the existing per-model requestId is the
//     modelCallId; multi-account fallback shares both, each attempt id is unique
//   - roles propagate through combo (primary), fusion (panel/judge) and auto
//     (classifier); internal auxiliary calls are excluded from the denominator
//   - only bounded enum reasons are emitted — never raw upstream error text
//   - telemetry is fire-and-forget and fail-open
//
// The producer is mocked (its own suite covers normalization/redaction); here we
// only assert the call lifecycle chat.js drives.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const events = [];
  return {
    events,
    enqueueRoutingEvent: vi.fn((entity, action, record) => {
      events.push({ entity, action, record });
      return true;
    }),
    handleChatCore: vi.fn(),
    getModelInfo: vi.fn(async (model) => ({ provider: "probe", model })),
    getComboModelEntries: vi.fn(async () => null),
    getComboByName: vi.fn(async () => null),
    getSettings: vi.fn(async () => ({ requireApiKey: false, comboStrategies: {}, providerStrategies: {}, providerThinking: {} })),
    getProviderCredentials: vi.fn(),
    markAccountUnavailable: vi.fn(async () => ({ shouldFallback: true, modelLevel: false, transport: false })),
    clearAccountError: vi.fn(async () => {}),
    recordProviderModelFailure: vi.fn(async () => ({ open: false })),
    clearProviderModelBreaker: vi.fn(async () => {}),
    checkAndRefreshToken: vi.fn(async (_p, c) => c),
    updateProviderCredentials: vi.fn(async () => {}),
    saveRequestUsage: vi.fn(async () => {}),
    handleComboChat: vi.fn(),
    handleFusionChat: vi.fn(),
    classifyAutoRequest: vi.fn(),
    normalizeAutoRoutingConfig: vi.fn((c) => c || {}),
    reorderByAutoLevel: vi.fn((entries) => entries),
  };
});

vi.mock("@/lib/redis/routingEvents.js", () => ({ enqueueRoutingEvent: mocks.enqueueRoutingEvent }));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: vi.fn(() => null) }));
vi.mock("open-sse/translator/formats.js", () => ({ detectFormatByEndpoint: vi.fn(() => null) }));
vi.mock("open-sse/services/projectId.js", () => ({ getProjectIdForConnection: vi.fn(async () => null) }));
vi.mock("open-sse/services/combo.js", () => ({
  handleComboChat: mocks.handleComboChat,
  handleFusionChat: mocks.handleFusionChat,
  detectRequiredCapabilities: vi.fn(() => new Set()),
  getComboModelsForRequest: vi.fn((models) => (Array.isArray(models) ? models : [])),
  getUnsupportedComboRequestCapability: vi.fn(() => null),
  getActiveComboModels: mocks.getActiveComboModels,
  getActiveComboModels: vi.fn((models) => models),
}));
vi.mock("open-sse/services/autoRouting.js", () => ({
  classifyAutoRequest: mocks.classifyAutoRequest,
  normalizeAutoRoutingConfig: mocks.normalizeAutoRoutingConfig,
  reorderByAutoLevel: mocks.reorderByAutoLevel,
}));
vi.mock("../../src/sse/services/routeLease.js", () => ({
  withRouteLease: vi.fn(async (_release, _signal, execute) => execute()),
}));
vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: vi.fn(() => null),
  authorizeApiKey: vi.fn(async () => null),
  resolveApiKeyAccessTags: vi.fn(async () => []),
}));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModelEntries: mocks.getComboModelEntries,
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: mocks.checkAndRefreshToken,
  updateProviderCredentials: mocks.updateProviderCredentials,
}));
vi.mock("../../src/sse/services/providerBreaker.js", () => ({
  clearProviderModelBreaker: mocks.clearProviderModelBreaker,
  recordProviderModelFailure: mocks.recordProviderModelFailure,
}));
vi.mock("../../src/sse/utils/logger.js", () => ({
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  routeLine: vi.fn(), line: vi.fn(), errorLine: vi.fn(),
  tagForSession: vi.fn(() => ""), nextTag: vi.fn(() => ""), maskKey: vi.fn((k) => `masked:${k}`),
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  getComboByName: mocks.getComboByName,
  getProviderNodes: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
  getApiKeyByValue: vi.fn(async () => null),
  getProviderConnections: vi.fn(async () => []),
  getProviderConnectionById: vi.fn(async () => null),
  validateApiKey: vi.fn(async () => null),
  updateProviderConnection: vi.fn(async () => {}),
  updateProviderConnectionHealth: vi.fn(async () => {}),
  getMouses: vi.fn(async () => []),
  getMouseExecutionDetails: vi.fn(async () => null),
}));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn(async () => null) }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("@/lib/requestLogPath.js", () => ({ REQUEST_LOGS_DIR: "/tmp" }));
vi.mock("@/lib/modelCapabilityOverrides", () => ({ refreshModelCapabilityOverrides: vi.fn(async () => {}) }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: mocks.saveRequestUsage }));
vi.mock("@/lib/networkTraffic.js", () => ({ getTrafficRequestId: vi.fn(() => null) }));
vi.mock("@/shared/utils/requestSource", () => ({ getRequestSourceMeta: vi.fn(() => ({})) }));
vi.mock("@/shared/utils/accessTags", () => ({
  canAccessWithTags: vi.fn(() => true),
  normalizeAccessTags: vi.fn((tags) => (Array.isArray(tags) ? tags : [])),
}));

const { handleChat } = await import("../../src/sse/handlers/chat.js");

const connection = (id) => ({
  connectionId: id,
  connectionName: `acc-${id}`,
  providerStrategy: {},
  providerSpecificData: {},
  releaseRouteSlot: vi.fn(),
});

function request(model = "probe/model-x", endpoint = "/v1/chat/completions") {
  return new Request(`https://router.test${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });
}

const okResult = () => ({ success: true, response: new Response("ok", { status: 200 }) });
const failResult = (status = 401, error = "invalid api key") => ({
  success: false, status, error,
  upstreamError: { layer: "provider", status, message: error },
  response: new Response("upstream error", { status }),
});

/** Let the lazily-loaded producer flush its buffer and deliver to the mock. */
async function flush() {
  for (let i = 0; i < 60; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const requests = () => mocks.events.filter((e) => e.entity === "request");
const attempts = () => mocks.events.filter((e) => e.entity === "attempt");
const requestUpserts = () => requests().filter((e) => e.action === "upsert");
const requestCompletes = () => requests().filter((e) => e.action === "complete");
const attemptUpserts = () => attempts().filter((e) => e.action === "upsert");
const attemptCompletes = () => attempts().filter((e) => e.action === "complete");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.events.length = 0;
  mocks.getModelInfo.mockImplementation(async (model) => ({ provider: "probe", model }));
  mocks.getComboModelEntries.mockResolvedValue(null);
  mocks.getComboByName.mockResolvedValue(null);
  mocks.getSettings.mockResolvedValue({ requireApiKey: false, comboStrategies: {}, providerStrategies: {}, providerThinking: {} });
  mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true, modelLevel: false, transport: false });
  mocks.recordProviderModelFailure.mockResolvedValue({ open: false });
  mocks.checkAndRefreshToken.mockImplementation(async (_p, c) => c);
  mocks.normalizeAutoRoutingConfig.mockImplementation((c) => c || {});
  mocks.reorderByAutoLevel.mockImplementation((entries) => entries);
});

describe("chat routing telemetry lifecycle", () => {
  it("falls back from an unprefixed Claude model to the Claude OAuth provider", async () => {
    mocks.getModelInfo.mockResolvedValue({ provider: "anthropic", model: "claude-sonnet-4-5" });
    mocks.getProviderCredentials
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(connection("claude-account"));
    mocks.handleChatCore.mockImplementation(async ({ modelInfo }) => {
      expect(modelInfo.provider).toBe("claude");
      return okResult();
    });

    const res = await handleChat(request("claude-sonnet-4-5"));

    expect(res.status).toBe(200);
    expect(mocks.getProviderCredentials.mock.calls.map(([provider]) => provider))
      .toEqual(["anthropic", "claude"]);
  });

  it("does not fall back for an explicitly selected Anthropic provider", async () => {
    mocks.getModelInfo.mockResolvedValue({ provider: "anthropic", model: "claude-sonnet-4-5" });
    mocks.getProviderCredentials.mockResolvedValue(null);

    const res = await handleChat(request("anthropic/claude-sonnet-4-5"));

    expect(res.status).toBe(404);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.getProviderCredentials.mock.calls[0][0]).toBe("anthropic");
  });

  it("routes a bare Claude Messages model to the configured OpenAI target without querying Anthropic", async () => {
    const originalModel = "claude-sonnet-4-5";
    let coreOptions;
    mocks.getSettings.mockResolvedValue({
      requireApiKey: false,
      claudeMessagesRoute: "openai/gpt-4o",
      comboStrategies: {},
      providerStrategies: {},
      providerThinking: {},
    });
    mocks.getModelInfo.mockImplementation(async (model) => {
      if (model === originalModel) return { provider: "anthropic", model };
      if (model === "openai/gpt-4o") return { provider: "openai", model: "gpt-4o" };
      return { provider: "probe", model };
    });
    mocks.getProviderCredentials.mockResolvedValue(connection("openai-account"));
    mocks.handleChatCore.mockImplementation(async (options) => {
      coreOptions = options;
      return okResult();
    });

    const res = await handleChat(request(originalModel, "/v1/messages"));

    expect(res.status).toBe(200);
    expect(mocks.getProviderCredentials.mock.calls.map(([provider]) => provider)).toEqual(["openai"]);
    expect(coreOptions.modelInfo).toMatchObject({
      provider: "openai",
      model: "gpt-4o",
      routeKind: "alias",
      routed: true,
    });
    expect(coreOptions.body.model).toBe("openai/gpt-4o");
    expect(coreOptions.clientRawRequest.body.model).toBe(originalModel);
  });

  it("routes the alternate Claude Messages endpoint to a configured DeepSeek target", async () => {
    const originalModel = "claude-sonnet-4-5";
    let coreOptions;
    mocks.getSettings.mockResolvedValue({
      requireApiKey: false,
      claudeMessagesRoute: "deepseek/deepseek-chat",
      comboStrategies: {},
      providerStrategies: {},
      providerThinking: {},
    });
    mocks.getModelInfo.mockImplementation(async (model) => {
      if (model === originalModel) return { provider: "anthropic", model };
      if (model === "deepseek/deepseek-chat") return { provider: "deepseek", model: "deepseek-chat" };
      return { provider: "probe", model };
    });
    mocks.getProviderCredentials.mockResolvedValue(connection("deepseek-account"));
    mocks.handleChatCore.mockImplementation(async (options) => {
      coreOptions = options;
      return okResult();
    });

    const res = await handleChat(request(originalModel, "/api/v1/messages"));

    expect(res.status).toBe(200);
    expect(mocks.getProviderCredentials.mock.calls.map(([provider]) => provider)).toEqual(["deepseek"]);
    expect(coreOptions.modelInfo).toMatchObject({
      provider: "deepseek",
      model: "deepseek-chat",
      routeKind: "alias",
      routed: true,
    });
    expect(coreOptions.body.model).toBe("deepseek/deepseek-chat");
    expect(coreOptions.clientRawRequest.body.model).toBe(originalModel);
  });

  it("does not apply the Claude Messages default route to Chat Completions", async () => {
    let coreOptions;
    mocks.getSettings.mockResolvedValue({
      requireApiKey: false,
      claudeMessagesRoute: "openai/gpt-4o",
      comboStrategies: {},
      providerStrategies: {},
      providerThinking: {},
    });
    mocks.getModelInfo.mockResolvedValue({ provider: "anthropic", model: "claude-sonnet-4-5" });
    mocks.getProviderCredentials.mockResolvedValue(connection("anthropic-account"));
    mocks.handleChatCore.mockImplementation(async (options) => {
      coreOptions = options;
      return okResult();
    });

    const res = await handleChat(request("claude-sonnet-4-5", "/v1/chat/completions"));

    expect(res.status).toBe(200);
    expect(mocks.getProviderCredentials.mock.calls.map(([provider]) => provider)).toEqual(["anthropic"]);
    expect(coreOptions.modelInfo).toMatchObject({ provider: "anthropic", model: "claude-sonnet-4-5" });
    expect(coreOptions.body.model).toBe("anthropic/claude-sonnet-4-5");
  });

  it("does not rewrite an explicitly prefixed model on the Claude Messages endpoint", async () => {
    let coreOptions;
    mocks.getSettings.mockResolvedValue({
      requireApiKey: false,
      claudeMessagesRoute: "openai/gpt-4o",
      comboStrategies: {},
      providerStrategies: {},
      providerThinking: {},
    });
    mocks.getModelInfo.mockResolvedValue({ provider: "anthropic", model: "claude-sonnet-4-5" });
    mocks.getProviderCredentials.mockResolvedValue(connection("anthropic-account"));
    mocks.handleChatCore.mockImplementation(async (options) => {
      coreOptions = options;
      return okResult();
    });

    const res = await handleChat(request("anthropic/claude-sonnet-4-5", "/v1/messages"));

    expect(res.status).toBe(200);
    expect(mocks.getProviderCredentials.mock.calls.map(([provider]) => provider)).toEqual(["anthropic"]);
    expect(coreOptions.body.model).toBe("anthropic/claude-sonnet-4-5");
    expect(coreOptions.modelInfo).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      routeKind: "direct",
      routed: false,
    });
  });
  it("routes a bare Claude Messages model through a configured combo target", async () => {
    const originalModel = "claude-sonnet-4-5";
    const combo = { name: "desktop-models", kind: "llm", isActive: true, models: ["openai/gpt-4o"], accessTags: [] };
    let coreOptions;
    mocks.getSettings.mockResolvedValue({
      requireApiKey: false,
      claudeMessagesRoute: "desktop-models",
      comboStrategies: {},
      providerStrategies: {},
      providerThinking: {},
    });
    mocks.getComboByName.mockImplementation(async (name) => name === "desktop-models" ? combo : null);
    mocks.getComboModelEntries.mockImplementation(async (model) => model === "desktop-models" ? ["openai/gpt-4o"] : null);
    mocks.getModelInfo.mockImplementation(async (model) => {
      if (model === originalModel) return { provider: "anthropic", model };
      if (model === "openai/gpt-4o") return { provider: "openai", model: "gpt-4o" };
      return { provider: "probe", model };
    });
    mocks.getProviderCredentials.mockResolvedValue(connection("openai-account"));
    mocks.handleChatCore.mockImplementation(async (options) => {
      coreOptions = options;
      return okResult();
    });
    mocks.handleComboChat.mockImplementation(async (options) => options.handleSingleModel(options.body, options.models[0]));

    const res = await handleChat(request(originalModel, "/v1/messages"));
    await flush();

    expect(res.status).toBe(200);
    expect(mocks.getProviderCredentials.mock.calls.map(([provider]) => provider)).toEqual(["openai"]);
    expect(mocks.handleComboChat.mock.calls[0][0].comboName).toBe("desktop-models");
    expect(coreOptions.modelInfo).toMatchObject({
      provider: "openai",
      model: "gpt-4o",
      routeKind: "combo",
      routed: true,
    });
  });
  it("opens and completes exactly one request around a single successful model call", async () => {
    mocks.getProviderCredentials.mockResolvedValue(connection("acc1"));
    mocks.handleChatCore.mockResolvedValue(okResult());

    const res = await handleChat(request());
    await flush();

    expect(res.status).toBe(200);
    expect(requestUpserts()).toHaveLength(1);
    expect(requestCompletes()).toHaveLength(1);
    expect(requestCompletes()[0].record.outcome).toBe("valid_terminal");
    expect(requestCompletes()[0].record.attemptCount).toBe(1);
    expect(attemptUpserts()).toHaveLength(1);
    expect(attemptCompletes()).toHaveLength(1);
    expect(attemptCompletes()[0].record.outcome).toBe("valid_terminal");
    expect(attemptUpserts()[0].record.role).toBe("primary");

    // The request id is stable across the upsert/complete pair.
    const requestId = requestUpserts()[0].record.routingRequestId;
    expect(requestCompletes()[0].record.routingRequestId).toBe(requestId);
    expect(attemptUpserts()[0].record.routingRequestId).toBe(requestId);
  });

  it("hands chatCore an observer that satisfies the stream pipeline's interface", async () => {
    // Regression guard. The session's observer exposes the RAW protocol callbacks
    // (onHeaders/onTerminal/...), while every chatCore response path calls
    // emitHeaders()/recordTerminal()/settle()/noteFirstToken()/hasTerminal() —
    // the interface of the fail-open wrapper. Passing the raw observer through
    // made the first streaming response throw
    //   TypeError: routingObserver.emitHeaders is not a function
    // (streamingHandler.js:93; the non-streaming and SSE→JSON paths likewise)
    // before any byte reached the client, i.e. a 500 on every chat request.
    //
    // This test mocks chatCore, so it cannot exercise the call itself — instead it
    // asserts the CONTRACT at the boundary that was actually wrong. The companion
    // test in codex-observer-wiring.test.js drives the real pipeline end to end.
    mocks.getProviderCredentials.mockResolvedValue(connection("acc1"));
    let observed = null;
    mocks.handleChatCore.mockImplementation(async (opts) => {
      observed = opts.routingObserver;
      return okResult();
    });

    await handleChat(request());
    await flush();

    expect(observed).toBeTruthy();
    for (const method of ["emitHeaders", "recordTerminal", "settle", "noteFirstToken", "hasTerminal"]) {
      expect(typeof observed[method], `observer.${method} must be a function`).toBe("function");
    }
  });

  it("prefers the chatCore observer terminal over the HTTP status", async () => {
    mocks.getProviderCredentials.mockResolvedValue(connection("acc1"));
    // chatCore settles the attempt observer from the upstream's own protocol
    // terminal. Here the upstream reached a real terminal even though the
    // result status alone would read as a generic failure.
    mocks.handleChatCore.mockImplementation(async (opts) => {
      // Drive the observer exactly as the real stream pipeline does: record the
      // upstream's protocol terminal, then settle (open-sse/utils/stream.js).
      // `opts.routingObserver` is the fail-open wrapper, whose surface is
      // emitHeaders/recordTerminal/settle — NOT the raw onTerminal callbacks.
      opts.routingObserver.recordTerminal({ outcome: "valid_terminal", terminalReason: "terminal" });
      opts.routingObserver.settle({ upstreamStatus: 200 });
      return { success: true, response: new Response("ok", { status: 200 }) };
    });

    await handleChat(request());
    await flush();

    expect(attemptCompletes()).toHaveLength(1);
    expect(attemptCompletes()[0].record.outcome).toBe("valid_terminal");
    expect(attemptCompletes()[0].record.terminalReason).toBe("terminal");
    expect(requestCompletes()[0].record.outcome).toBe("valid_terminal");
  });

  it("does not let a later transport failure relabel a recorded protocol terminal", async () => {
    mocks.getProviderCredentials.mockResolvedValue(connection("acc1"));
    // Terminal (no account rotation) so the loop ends after this one attempt.
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false, modelLevel: false, transport: false });
    mocks.handleChatCore.mockImplementation(async (opts) => {
      // The upstream stream reached a real terminal...
      opts.routingObserver.recordTerminal({ outcome: "valid_terminal", terminalReason: "terminal" });
      opts.routingObserver.settle({ upstreamStatus: 200 });
      // ...then the socket dropped, so the executor reports a failure result.
      return { success: false, status: 502, error: "socket hang up", response: new Response("", { status: 502 }) };
    });

    await handleChat(request());
    await flush();

    // The observer's terminal is exactly-once and wins; the attempt is not
    // relabelled by the result-derived failure.
    expect(attemptCompletes()).toHaveLength(1);
    expect(attemptCompletes()[0].record.outcome).toBe("valid_terminal");
  });

  it("shares one routingRequestId and modelCallId across accounts, with unique attempt ids", async () => {
    const accounts = [connection("acc1"), connection("acc2"), connection("acc3")];
    mocks.getProviderCredentials.mockImplementation(async () => accounts.shift() || null);
    mocks.handleChatCore.mockResolvedValue(failResult(401, "invalid api key"));

    const res = await handleChat(request());
    await flush();

    expect(res.status).toBe(401);
    expect(attemptUpserts()).toHaveLength(3);
    expect(attemptCompletes()).toHaveLength(3);

    const routingIds = new Set(attemptUpserts().map((e) => e.record.routingRequestId));
    const modelCallIds = new Set(attemptUpserts().map((e) => e.record.modelCallId));
    const attemptIds = new Set(attemptUpserts().map((e) => e.record.attemptId));
    expect(routingIds.size).toBe(1);
    expect(modelCallIds.size).toBe(1);
    expect(attemptIds.size).toBe(3);
    // The modelCallId is the existing per-model requestId, distinct from the routing id.
    expect([...modelCallIds][0]).not.toBe([...routingIds][0]);

    // Each rotated account attempt records the account it used and a bounded reason.
    expect(new Set(attemptUpserts().map((e) => e.record.connectionId))).toEqual(new Set(["acc1", "acc2", "acc3"]));
    expect(attemptCompletes().every((e) => e.record.terminalReason === "account_fallback")).toBe(true);

    expect(requestCompletes()[0].record.outcome).toBe("failed");
    expect(requestCompletes()[0].record.attemptCount).toBe(3);
  });

  it("records the combo strategy on the request and role primary on the model attempt", async () => {
    mocks.getComboModelEntries.mockResolvedValue(["a/one", "b/two"]);
    mocks.getComboByName.mockResolvedValue({ accessTags: [] });
    mocks.getProviderCredentials.mockResolvedValue(connection("acc1"));
    mocks.handleChatCore.mockResolvedValue(okResult());
    mocks.handleComboChat.mockImplementation(async (opts) => opts.handleSingleModel(opts.body, opts.models[0]));

    await handleChat(request("my-combo"));
    await flush();

    const complete = requestCompletes()[0].record;
    expect(complete.strategy).toBe("fallback");
    expect(complete.comboName).toBe("my-combo");
    expect(attemptUpserts().every((e) => e.record.role === "primary")).toBe(true);
  });

  it("labels fusion panel and judge calls distinctly", async () => {
    mocks.getComboModelEntries.mockResolvedValue(["panel/a", "panel/b"]);
    mocks.getComboByName.mockResolvedValue({ accessTags: [] });
    mocks.getSettings.mockResolvedValue({
      requireApiKey: false,
      providerStrategies: {},
      providerThinking: {},
      comboStrategies: { "my-combo": { fallbackStrategy: "fusion", judgeModel: "judge/model" } },
    });
    mocks.getProviderCredentials.mockResolvedValue(connection("acc1"));
    mocks.handleChatCore.mockResolvedValue(okResult());
    mocks.handleFusionChat.mockImplementation(async (opts) => {
      await opts.handleSingleModel(opts.body, opts.models[0], true);
      return opts.handleSingleModel(opts.body, "judge/model", false);
    });

    await handleChat(request("my-combo"));
    await flush();

    expect(requestCompletes()[0].record.strategy).toBe("fusion");
    const roles = attemptUpserts().map((e) => e.record.role).sort();
    expect(roles).toEqual(["judge", "panel"]);
  });

  it("marks the auto classifier call with role classifier and excludes it from the denominator", async () => {
    mocks.getComboModelEntries.mockResolvedValue(["m/a"]);
    mocks.getComboByName.mockResolvedValue({ accessTags: [] });
    mocks.getSettings.mockResolvedValue({
      requireApiKey: false,
      providerStrategies: {},
      providerThinking: {},
      comboStrategies: { "my-combo": { fallbackStrategy: "auto", autoRouting: { classifierModel: "cls/model" } } },
    });
    mocks.normalizeAutoRoutingConfig.mockReturnValue({ classifierModel: "cls/model", classifierTimeoutMs: 1000, levelOrder: [] });
    mocks.getProviderCredentials.mockResolvedValue(connection("acc1"));
    mocks.handleChatCore.mockResolvedValue(okResult());
    mocks.classifyAutoRequest.mockImplementation(async ({ callModel, body, signal }) => {
      await callModel(body, "cls/model", signal);
      return { level: "simple", confidence: 0.9, source: "classifier" };
    });
    mocks.handleComboChat.mockImplementation(async (opts) => opts.handleSingleModel(opts.body, opts.models[0]));

    await handleChat(request("my-combo"));
    await flush();

    const roles = attemptUpserts().map((e) => e.record.role);
    expect(roles).toContain("classifier");
    expect(roles).toContain("primary");
    // The classifier call is auxiliary: it must not inflate the request denominator.
    expect(requestCompletes()[0].record.attemptCount).toBe(1);
    expect(requestCompletes()[0].record.autoSource).toBe("classifier");
  });

  it("completes the request as cancelled on a client abort", async () => {
    mocks.getProviderCredentials.mockResolvedValue(connection("acc1"));
    mocks.handleChatCore.mockResolvedValue({ success: false, status: 499, error: "Request aborted", response: new Response("", { status: 499 }) });

    const res = await handleChat(request());
    await flush();

    expect(res.status).toBe(499);
    expect(requestCompletes()[0].record.outcome).toBe("cancelled");
    expect(requestCompletes()[0].record.terminalReason).toBe("client_abort");
    expect(attemptCompletes()[0].record.outcome).toBe("cancelled");
  });

  it("records a bounded blocked reason when no account is available", async () => {
    mocks.getProviderCredentials.mockResolvedValue(null);

    const res = await handleChat(request());
    await flush();

    expect(res.status).toBe(404);
    expect(attemptUpserts()).toHaveLength(0);
    expect(requestCompletes()[0].record.outcome).toBe("failed");
    expect(requestCompletes()[0].record.terminalReason).toBe("no_account");
  });

  it("emits only bounded enum reasons and no sensitive request fields", async () => {
    mocks.getProviderCredentials.mockResolvedValue(connection("acc1"));
    // A terminal upstream failure (no account rotation) so the loop ends after one
    // attempt; the point here is what the emitted records contain, not retries.
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false, modelLevel: false, transport: false });
    mocks.handleChatCore.mockResolvedValue(failResult(500, "RAW UPSTREAM BODY sk-live-SECRET"));

    await handleChat(request());
    await flush();

    const reasons = new Set([
      ...requestCompletes().map((e) => e.record.terminalReason),
      ...attemptCompletes().map((e) => e.record.terminalReason),
    ]);
    for (const reason of reasons) {
      expect(typeof reason).toBe("string");
      expect(reason).not.toContain("SECRET");
    }
    for (const event of mocks.events) {
      const serialized = JSON.stringify(event.record);
      expect(serialized).not.toContain("SECRET");
      expect(serialized).not.toContain("messages");
      expect(event.record.body).toBeUndefined();
      expect(event.record.apiKey).toBeUndefined();
      expect(event.record.error).toBeUndefined();
    }
  });

  it("does not settle a streaming attempt from the lazy success result", async () => {
    // handleStreamingResponse returns `{ success: true, streaming: true, response }`
    // where response is a LAZY ReadableStream — not one byte has been read, so the
    // attempt's ttft/duration/usage do not exist yet. chat.js used to call
    // attempt.complete(attemptTerminalFromResult(result)) here. Because the
    // session's complete() is first-wins, that latched durationMs=0/ttftMs=0/null
    // tokens and DISCARDED the real numbers the stream computes moments later.
    // Production showed it: 165/165 stream attempts at durationMs=0 while
    // completedAt-startedAt ranged 1.6s-79.7s.
    //
    // The settle must come from the stream pipeline (open-sse/utils/stream.js),
    // so after handleChat returns there must be NO attempt completion yet.
    mocks.getProviderCredentials.mockResolvedValue(connection("acc1"));
    mocks.handleChatCore.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { success: true, streaming: true, response: new Response("sse", { status: 200 }) };
    });

    await handleChat(request());
    await flush();

    expect(attemptCompletes()).toHaveLength(0);
  });

  it("records the stream's real duration and tokens, not the dispatch placeholder", async () => {
    mocks.getProviderCredentials.mockResolvedValue(connection("acc1"));
    let observer = null;
    mocks.handleChatCore.mockImplementation(async (opts) => {
      observer = opts.routingObserver;
      // Give the request a measurable age so a dispatch-time placeholder (≈0)
      // is distinguishable from the stream's real duration.
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { success: true, streaming: true, response: new Response("sse", { status: 200 }) };
    });

    await handleChat(request());
    await flush();

    // The attempt is still open; now drive it exactly as stream.js does when the
    // upstream stream actually terminates.
    expect(attemptCompletes()).toHaveLength(0);
    observer.noteFirstToken();
    observer.recordTerminal({ outcome: "valid_terminal", terminalReason: "terminal" });
    observer.settle({ upstreamStatus: 200, usage: { prompt_tokens: 11, completion_tokens: 7 } });
    await flush();

    expect(attemptCompletes()).toHaveLength(1);
    const complete = attemptCompletes()[0].record;
    expect(complete.outcome).toBe("valid_terminal");
    // The numbers the report consumes must come from the stream, and must not be
    // the zeroed placeholder the early complete() used to latch.
    expect(complete.durationMs).toBeGreaterThanOrEqual(50);
    expect(complete.promptTokens).toBe(11);
    expect(complete.completionTokens).toBe(7);
  });

  it("does not throw when the producer rejects an event (fail-open)", async () => {
    mocks.enqueueRoutingEvent.mockImplementation(() => { throw new Error("producer exploded"); });
    mocks.getProviderCredentials.mockResolvedValue(connection("acc1"));
    mocks.handleChatCore.mockResolvedValue(okResult());

    const res = await handleChat(request());
    await flush();

    expect(res.status).toBe(200);
  });
});
