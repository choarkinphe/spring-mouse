import os from "node:os";
import { getAppVersion } from "@/lib/db/version";

function roundToOneDecimal(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Build a lightweight snapshot of the Spring Mouse server process.
 *
 * CPU time returned by Node is cumulative, so the percentage is derived from
 * two samples instead of treating the cumulative value as a point-in-time rate.
 */
export function createSystemStatusCollector({
  processRef = process,
  osRef = os,
  getVersion = getAppVersion,
  now = () => Date.now(),
} = {}) {
  let previousCpuSample = null;

  return function getSystemStatus() {
    const nowMs = now();
    const cpuUsage = processRef.cpuUsage();
    let processCpuPercent = null;

    if (previousCpuSample) {
      const elapsedMicros = Math.max(0, (nowMs - previousCpuSample.timestampMs) * 1000);
      const usedMicros = Math.max(
        0,
        cpuUsage.user - previousCpuSample.cpuUsage.user + cpuUsage.system - previousCpuSample.cpuUsage.system,
      );

      if (elapsedMicros > 0) {
        processCpuPercent = roundToOneDecimal((usedMicros / elapsedMicros) * 100);
      }
    }

    previousCpuSample = { timestampMs: nowMs, cpuUsage };

    const memory = processRef.memoryUsage();
    const cpus = osRef.cpus();

    return {
      version: getVersion(),
      uptimeSeconds: Math.max(0, Math.floor(processRef.uptime())),
      cpu: {
        // This is the Spring Mouse process, not the aggregate machine CPU usage.
        processPercent: processCpuPercent,
        cores: Array.isArray(cpus) ? cpus.length : 0,
        loadAverage: typeof osRef.loadavg === "function" ? osRef.loadavg() : [],
      },
      memory: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external ?? 0,
        arrayBuffersBytes: memory.arrayBuffers ?? 0,
      },
      sampledAt: new Date(nowMs).toISOString(),
    };
  };
}

const getSystemStatus = createSystemStatusCollector();

export { getSystemStatus };
