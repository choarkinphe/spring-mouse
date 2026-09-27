// Fail-open integration check: the producer must degrade gracefully against the
// REAL routingClient (not a mock) when Redis is not configured, which is the
// default for local installs. This is the production failure mode that must
// never throw into the chat path.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  enqueueRoutingRequest,
  getRoutingTelemetryHealth,
  ROUTING_ACTION_UPSERT,
  __test,
} from "@/lib/redis/routingEvents.js";

const originalUrl = process.env.SPRING_MOUSE_REDIS_URL;

beforeEach(() => {
  __test.reset();
  delete process.env.SPRING_MOUSE_REDIS_URL;
});

afterEach(() => {
  __test.reset();
  if (originalUrl === undefined) delete process.env.SPRING_MOUSE_REDIS_URL;
  else process.env.SPRING_MOUSE_REDIS_URL = originalUrl;
});

async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("fail-open without Redis configured", () => {
  it("enqueue never throws and returns true (accepted, then dropped at delivery)", async () => {
    expect(() => enqueueRoutingRequest(ROUTING_ACTION_UPSERT, { routingRequestId: "failopen-1" })).not.toThrow();
    await flush();
    const health = getRoutingTelemetryHealth();
    // Accepted into the bounded queue, delivery failed, no crash.
    expect(health.enqueued).toBe(1);
    expect(health.failed).toBe(1);
    expect(health.errors).toBe(0);
  });

  it("health is readable and process-local with no Redis configured", () => {
    const health = getRoutingTelemetryHealth();
    expect(health.scope).toBe("process-local");
    expect(typeof health.queued).toBe("number");
    // Unconfigured Redis reports a disconnected status, not a crash.
    expect(health.redis).toMatchObject({ connected: false });
  });
});
