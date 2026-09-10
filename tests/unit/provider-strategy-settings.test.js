import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = await mkdtemp(path.join(tmpdir(), "spring-mouse-provider-strategy-"));

let PATCH;

beforeAll(async () => {
  ({ PATCH } = await import("@/app/api/settings/route.js"));
});

function patchRequest(body) {
  return new Request("http://localhost/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function saveStrategy(entry) {
  const response = await PATCH(patchRequest({ providerStrategies: { demo: entry } }));
  expect(response.status).toBe(200);
  const payload = await response.json();
  return payload.providerStrategies?.demo;
}

describe("provider strategy settings", () => {
  it("stores durations sent in seconds (the channel modal contract)", async () => {
    const saved = await saveStrategy({
      hardConcurrencyEnabled: true,
      providerMaxConcurrentStreams: 7,
      maxConcurrentStreams: 3,
      queueTimeoutSeconds: 90,
      maxQueueSize: 25,
      enableModelBreaker: true,
      breakerThreshold: 9,
      breakerWindowSeconds: 300,
      breakerCooldownSeconds: 150,
    });

    expect(saved).toEqual({
      hardConcurrencyEnabled: true,
      providerMaxConcurrentStreams: 7,
      maxConcurrentStreams: 3,
      queueTimeoutMs: 90_000,
      maxQueueSize: 25,
      enableModelBreaker: true,
      breakerThreshold: 9,
      breakerWindowMs: 300_000,
      breakerCooldownMs: 150_000,
    });
  });

  it("still stores durations from a client that sends raw milliseconds", async () => {
    // A cached/older bundle sends queueTimeoutMs — dropping those fields made
    // every duration silently snap back to its default after a reload.
    const saved = await saveStrategy({
      queueTimeoutMs: 30_000,
      breakerWindowMs: 240_000,
      breakerCooldownMs: 45_000,
      maxQueueSize: 10,
    });

    expect(saved).toEqual({
      queueTimeoutMs: 30_000,
      maxQueueSize: 10,
      breakerWindowMs: 240_000,
      breakerCooldownMs: 45_000,
    });
  });

  it("prefers the seconds form when a client sends both", async () => {
    const saved = await saveStrategy({ queueTimeoutSeconds: 5, queueTimeoutMs: 999_999 });
    expect(saved).toEqual({ queueTimeoutMs: 5_000 });
  });

  it("keeps routing fields and drops empty or malformed entries", async () => {
    const response = await PATCH(patchRequest({
      providerStrategies: {
        routed: { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 3 },
        empty: {},
        broken: "nope",
        "  ": { breakerThreshold: 4 },
      },
    }));
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.providerStrategies).toEqual({
      routed: { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 3 },
    });
  });

  it("ignores non-positive numbers instead of persisting them", async () => {
    const saved = await saveStrategy({
      providerMaxConcurrentStreams: 0,
      breakerThreshold: -2,
      breakerCooldownSeconds: 0,
      maxQueueSize: 50,
    });
    expect(saved).toEqual({ maxQueueSize: 50 });
  });
});
