import { createHistogram, monitorEventLoopDelay } from "node:perf_hooks";
import { getLocalSlotStatus } from "../redis/connectionSlots.js";
import { getRoutingRedisStatus } from "../redis/routingClient.js";

const state = globalThis.__smConcurrencyMetrics ||= {
  routing: createHistogram(),
  eventLoop: monitorEventLoopDelay({ resolution: 20 }),
};
state.eventLoop.enable();
export function recordRoutingDuration(ms) {
  if (Number.isFinite(ms) && ms >= 0) state.routing.record(Math.max(1, Math.round(ms * 1e6)));
}
function summary(histogram) {
  if (!histogram.count) return { count: 0, p50Ms: null, p95Ms: null, maxMs: null };
  const ms = (value) => Math.round(value / 1e4) / 100;
  return { count: histogram.count, p50Ms: ms(histogram.percentile(50)), p95Ms: ms(histogram.percentile(95)), maxMs: ms(histogram.max) };
}
export function getConcurrencyStatus() {
  return {
    scope: "process-lifetime", routing: summary(state.routing), eventLoop: summary(state.eventLoop),
    slots: getLocalSlotStatus(), redis: getRoutingRedisStatus(),
  };
}
