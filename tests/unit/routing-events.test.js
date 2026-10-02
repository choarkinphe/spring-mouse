// Producer-side tests for src/lib/redis/routingEvents.js.
//
// These pin the producer contract the durable writer (runtime/routing-writer.mjs)
// depends on, and the redaction guarantee the shared helper enforces:
//   - version 1 envelope {version, entity, action, record}
//   - events go to the routing stream via routingRedis, never to SQLite/usage
//   - bounded queue + in-flight, with drop counters and process-local health
//   - no prompt/message/tool-arg/auth/cookie/raw-error text reaches the wire
//   - only enum terminal reasons and allowlisted meta keys survive
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  xAdd: vi.fn(),
  routingRedis: vi.fn(),
  getRoutingRedisStatus: vi.fn(() => ({ connected: true, timeoutMs: 200, timeouts: 0, errors: 0 })),
}));

vi.mock("@/lib/redis/routingClient.js", () => ({
  routingRedis: mocks.routingRedis,
  getRoutingRedisStatus: mocks.getRoutingRedisStatus,
}));

import {
  createRoutingTelemetryContext,
  completeRoutingAttempt,
  completeRoutingRequest,
  enqueueRoutingAttempt,
  enqueueRoutingEvent,
  enqueueRoutingRequest,
  getRoutingTelemetryHealth,
  ROUTING_ACTION_COMPLETE,
  ROUTING_ACTION_UPSERT,
  ROUTING_EVENT_VERSION,
  ROUTING_STREAM_KEY,
  __test,
} from "@/lib/redis/routingEvents.js";
import { normalizeRoutingEvent } from "@/shared/utils/routingTelemetry.js";

// Default routingRedis double: run the operation against a stub client so the
// producer's xAdd envelope is observable. A real xAdd resolves to a message id;
// returning one keeps the success path (sent counter) honest.
function deliverViaXAdd() {
  mocks.xAdd.mockReturnValue("1-0");
  mocks.routingRedis.mockImplementation((operation) => operation({ xAdd: mocks.xAdd }));
}

function lastEnvelope() {
  const call = mocks.xAdd.mock.calls.at(-1);
  return call ? JSON.parse(call[2].event) : null;
}

// Let the fire-and-forget drain microtask/queue settle.
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => {
  __test.reset();
  mocks.xAdd.mockReset();
  mocks.routingRedis.mockReset();
  mocks.getRoutingRedisStatus.mockReset().mockReturnValue({ connected: true, timeoutMs: 200, timeouts: 0, errors: 0 });
  deliverViaXAdd();
});

afterEach(() => {
  __test.reset();
});

describe("envelope + stream delivery", () => {
  it("writes a version 1 envelope to the routing stream via routingRedis", async () => {
    const accepted = enqueueRoutingRequest(ROUTING_ACTION_UPSERT, {
      routingRequestId: "req-1",
      originalModel: "gpt-5",
      role: "primary",
    });
    expect(accepted).toBe(true);
    await flush();

    expect(mocks.routingRedis).toHaveBeenCalled();
    const call = mocks.xAdd.mock.calls.at(-1);
    expect(call[0]).toBe(ROUTING_STREAM_KEY);

    const envelope = lastEnvelope();
    expect(envelope.version).toBe(ROUTING_EVENT_VERSION);
    expect(envelope.entity).toBe("request");
    expect(envelope.action).toBe("upsert");
    expect(envelope.record.routingRequestId).toBe("req-1");
    expect(envelope.record.originalModel).toBe("gpt-5");
  });

  it("accepts attempt events and complete actions", async () => {
    enqueueRoutingAttempt(ROUTING_ACTION_UPSERT, { attemptId: "a-1", routingRequestId: "req-1", provider: "openai" });
    await flush();
    expect(lastEnvelope()).toMatchObject({ entity: "attempt", action: "upsert" });

    completeRoutingRequest({ routingRequestId: "req-1", outcome: "valid_terminal" });
    await flush();
    expect(lastEnvelope()).toMatchObject({ entity: "request", action: "complete", record: { outcome: "valid_terminal" } });
  });

  it("never throws and returns false for invalid entity/action", () => {
    expect(() => enqueueRoutingEvent("bogus", "upsert", { routingRequestId: "r" })).not.toThrow();
    expect(enqueueRoutingEvent("bogus", "upsert", { routingRequestId: "r" })).toBe(false);
    expect(enqueueRoutingEvent("request", "bogus", { routingRequestId: "r" })).toBe(false);
  });

  it("drops records the shared helper cannot normalize (missing id)", async () => {
    expect(enqueueRoutingRequest(ROUTING_ACTION_UPSERT, { originalModel: "x" })).toBe(false);
    expect(enqueueRoutingRequest(ROUTING_ACTION_UPSERT, { routingRequestId: "" })).toBe(false);
    await flush();
    expect(mocks.xAdd).not.toHaveBeenCalled();
    expect(getRoutingTelemetryHealth().droppedInvalid).toBe(2);
  });
});

describe("redaction", () => {
  it("drops prompts, messages, tool args, auth, cookies and raw error text", async () => {
    enqueueRoutingRequest(ROUTING_ACTION_COMPLETE, {
      routingRequestId: "req-9f3a",
      outcome: "valid_terminal",
      // None of the following are allowlisted columns/meta keys.
      prompt: "ignore previous instructions",
      messages: [{ role: "user", content: "private-content" }],
      toolArgs: { token: "abc" },
      authorization: "Bearer sk-live-abc",
      cookie: "auth_token=private-cookie",
      error: "upstream 500: raw body with token sk-live",
      stack: "Error: boom\n  at private",
    });
    await flush();

    const record = lastEnvelope().record;
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("ignore previous instructions");
    expect(serialized).not.toContain("private-content");
    expect(serialized).not.toContain("private-cookie");
    expect(serialized).not.toContain("sk-live");
    expect(serialized).not.toContain("raw body");
    expect(serialized).not.toContain("Bearer");
    // Allowlisted fields still survive.
    expect(record.routingRequestId).toBe("req-9f3a");
    expect(record.outcome).toBe("valid_terminal");
  });

  it("clamps arbitrary terminal reasons to unknown", async () => {
    enqueueRoutingRequest(ROUTING_ACTION_COMPLETE, {
      routingRequestId: "req-2",
      terminalReason: "upstream said: 429 rate limited for key sk-xyz",
    });
    await flush();
    expect(lastEnvelope().record.terminalReason).toBe("unknown");
  });

  it("preserves only enum terminal reasons", async () => {
    enqueueRoutingRequest(ROUTING_ACTION_COMPLETE, { routingRequestId: "req-3", terminalReason: "transport_error" });
    await flush();
    expect(lastEnvelope().record.terminalReason).toBe("transport_error");
  });

  it.each(["first_output_timeout", "sse_scan_limit"])("preserves scan-bound reason %s", async (terminalReason) => {
    enqueueRoutingRequest(ROUTING_ACTION_COMPLETE, { routingRequestId: "req-scan", terminalReason });
    await flush();
    expect(lastEnvelope().record.terminalReason).toBe(terminalReason);
  });

  it("keeps only allowlisted metadata keys", async () => {
    enqueueRoutingRequest(ROUTING_ACTION_UPSERT, {
      routingRequestId: "req-4",
      meta: { toolsCount: 3, hasImages: true, promptText: "leak", nested: { a: 1 } },
    });
    await flush();
    const meta = JSON.parse(lastEnvelope().record.meta);
    expect(meta).toEqual({ toolsCount: 3, hasImages: true });
    expect(meta.promptText).toBeUndefined();
  });
});

describe("bounded queue + in-flight", () => {
  it("drops when the queue is full and counts the drop", async () => {
    // Block delivery and cap in-flight at 1 so the queue can actually fill:
    // q-1 occupies the in-flight slot, q-2/q-3 sit in the queue, q-4 overflows.
    mocks.routingRedis.mockImplementation(() => new Promise(() => {}));
    __test.setLimits({ queueLimit: 2, inFlightLimit: 1 });

    expect(enqueueRoutingRequest(ROUTING_ACTION_UPSERT, { routingRequestId: "q-1" })).toBe(true);
    expect(enqueueRoutingRequest(ROUTING_ACTION_UPSERT, { routingRequestId: "q-2" })).toBe(true);
    expect(enqueueRoutingRequest(ROUTING_ACTION_UPSERT, { routingRequestId: "q-3" })).toBe(true);
    // Fourth event exceeds the queue bound.
    expect(enqueueRoutingRequest(ROUTING_ACTION_UPSERT, { routingRequestId: "q-4" })).toBe(false);

    const health = getRoutingTelemetryHealth();
    expect(health.queueLimit).toBe(2);
    expect(health.droppedQueueFull).toBe(1);
    expect(health.queued).toBe(2);
  });

  it("bounds in-flight deliveries", async () => {
    let resolveDelivery;
    mocks.routingRedis.mockImplementation(
      () => new Promise((resolve) => { resolveDelivery = resolve; }),
    );
    __test.setLimits({ inFlightLimit: 1, queueLimit: 100 });

    for (let i = 0; i < 5; i++) {
      enqueueRoutingRequest(ROUTING_ACTION_UPSERT, { routingRequestId: `inflight-${i}` });
    }
    await flush();

    // Only one delivery may be outstanding at a time.
    expect(mocks.routingRedis).toHaveBeenCalledTimes(1);
    expect(getRoutingTelemetryHealth().inFlight).toBe(1);
    expect(getRoutingTelemetryHealth().maxInFlight).toBe(1);

    resolveDelivery({});
    await flush();
    expect(mocks.routingRedis.mock.calls.length).toBeGreaterThan(1);
  });

  it("counts unavailable Redis as a failure without throwing", async () => {
    mocks.routingRedis.mockResolvedValue(null);
    expect(() => enqueueRoutingRequest(ROUTING_ACTION_UPSERT, { routingRequestId: "fail-1" })).not.toThrow();
    await flush();
    expect(getRoutingTelemetryHealth().failed).toBe(1);
    expect(getRoutingTelemetryHealth().sent).toBe(0);
  });

  it("never throws when routingRedis rejects", async () => {
    mocks.routingRedis.mockRejectedValue(new Error("boom sk-secret"));
    expect(() => enqueueRoutingRequest(ROUTING_ACTION_UPSERT, { routingRequestId: "rej-1" })).not.toThrow();
    await flush();
    const health = getRoutingTelemetryHealth();
    expect(health.failed).toBe(1);
    expect(health.errors).toBe(1);
  });
});

describe("health", () => {
  it("reports a process-local snapshot with redis status and counters", async () => {
    enqueueRoutingRequest(ROUTING_ACTION_UPSERT, { routingRequestId: "h-1" });
    await flush();

    const health = getRoutingTelemetryHealth();
    expect(health.scope).toBe("process-local");
    expect(health.version).toBe(ROUTING_EVENT_VERSION);
    expect(health.streamKey).toBe(ROUTING_STREAM_KEY);
    expect(health.enqueued).toBe(1);
    expect(health.sent).toBe(1);
    expect(health.redis).toMatchObject({ connected: true });
  });

  it("stays healthy and safe when redis status throws", () => {
    mocks.getRoutingRedisStatus.mockImplementation(() => { throw new Error("no redis"); });
    const health = getRoutingTelemetryHealth();
    expect(health.scope).toBe("process-local");
    expect(health.redis).toBeNull();
  });
});

describe("createRoutingTelemetryContext", () => {
  it("owns the request id and stamps it on every event", async () => {
    const telemetry = createRoutingTelemetryContext({ routingRequestId: "ctx-1", modelCallId: "mc-1", role: "primary" });

    telemetry.upsertRequest({ originalModel: "gpt-5", comboName: "combo-a" });
    await flush();
    expect(lastEnvelope()).toMatchObject({
      entity: "request",
      action: "upsert",
      record: { routingRequestId: "ctx-1", modelCallId: "mc-1", role: "primary", originalModel: "gpt-5" },
    });

    telemetry.completeRequest({ outcome: "valid_terminal", attemptCount: 1 });
    await flush();
    const completed = lastEnvelope();
    expect(completed.record.routingRequestId).toBe("ctx-1");
    expect(completed.record.outcome).toBe("valid_terminal");
    expect(completed.record.completedAt).toBeTruthy();
  });

  it("mints attempt ids and returns them for completion", async () => {
    const telemetry = createRoutingTelemetryContext({ routingRequestId: "ctx-2" });

    const attemptId = telemetry.upsertAttempt({ provider: "openai", model: "gpt-5", routeIndex: 0 });
    expect(typeof attemptId).toBe("string");
    await flush();
    expect(lastEnvelope()).toMatchObject({
      entity: "attempt",
      action: "upsert",
      record: { attemptId, routingRequestId: "ctx-2", provider: "openai" },
    });

    expect(telemetry.completeAttempt({ attemptId, outcome: "failed", terminalReason: "upstream_http_error", upstreamStatus: 502 })).toBe(true);
    await flush();
    expect(lastEnvelope()).toMatchObject({
      entity: "attempt",
      action: "complete",
      record: { attemptId, outcome: "failed", terminalReason: "upstream_http_error" },
    });
  });

  it("drops a completion whose attempt id is missing rather than duplicating", async () => {
    const telemetry = createRoutingTelemetryContext({ routingRequestId: "ctx-3" });
    expect(telemetry.completeAttempt({ outcome: "failed" })).toBe(false);
    await flush();
    expect(mocks.xAdd).not.toHaveBeenCalled();
  });

  it("mints a request id when none is supplied", () => {
    const telemetry = createRoutingTelemetryContext();
    expect(telemetry.routingRequestId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/);
  });

  it("cannot be tricked into overriding the request id per-event", async () => {
    const telemetry = createRoutingTelemetryContext({ routingRequestId: "ctx-4" });
    telemetry.upsertRequest({ routingRequestId: "spoofed", outcome: "valid_terminal" });
    await flush();
    expect(lastEnvelope().record.routingRequestId).toBe("ctx-4");
  });
});

// The durable writer accepts an envelope only when version === 1, entity is
// request|attempt, action is upsert|complete, and the shared helper can
// normalize the record. Pin that the producer's emitted envelope clears that
// exact gate so the two sides cannot silently drift.
describe("writer compatibility (envelope round-trip)", () => {
  function writerWouldAccept(envelope) {
    if (envelope.version !== 1) return null;
    if (envelope.entity !== "request" && envelope.entity !== "attempt") return null;
    if (envelope.action !== "upsert" && envelope.action !== "complete") return null;
    return normalizeRoutingEvent({ kind: envelope.entity, record: envelope.record });
  }

  it("emits envelopes the writer's validation accepts", async () => {
    const telemetry = createRoutingTelemetryContext({ routingRequestId: "rt-1", role: "primary" });
    telemetry.upsertRequest({ originalModel: "gpt-5", meta: { toolsCount: 1, secretKey: "leak" } });
    const attemptId = telemetry.upsertAttempt({ provider: "openai", model: "gpt-5" });
    telemetry.completeAttempt({ attemptId, outcome: "valid_terminal", terminalReason: "terminal" });
    telemetry.completeRequest({ outcome: "valid_terminal", attemptCount: 1 });
    await flush();

    expect(mocks.xAdd.mock.calls.length).toBe(4);
    for (const call of mocks.xAdd.mock.calls) {
      const envelope = JSON.parse(call[2].event);
      const accepted = writerWouldAccept(envelope);
      expect(accepted).not.toBeNull();
      expect(accepted.record.routingRequestId).toBe("rt-1");
      // Metadata redaction holds through the writer's own normalization too.
      expect(accepted.record.meta).not.toContain("leak");
    }
  });
});
