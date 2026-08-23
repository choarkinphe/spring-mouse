import { describe, expect, it, vi } from "vitest";
import {
  HEALTH_CHECK_DELAY_MS,
  INITIAL_RETRY_DELAY_MS,
  createCloudflareTunnelSupervisor,
} from "@/shared/services/cloudflareTunnelSupervisor";

function makeSupervisor(overrides = {}) {
  const scheduled = [];
  const schedule = vi.fn((callback, delayMs) => {
    scheduled.push({ callback, delayMs });
    return { unref() {} };
  });
  const supervisor = createCloudflareTunnelSupervisor({
    loadSettings: vi.fn().mockResolvedValue({ cloudflareTunnelEnabled: true }),
    getStatus: vi.fn().mockReturnValue({ running: false }),
    startTunnel: vi.fn().mockResolvedValue({ running: true, publicUrl: "https://mouse.example.com" }),
    schedule,
    log: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  });
  return { supervisor, schedule, scheduled };
}

describe("Cloudflare Tunnel startup supervisor", () => {
  it("retries a failed Docker-boot start and then switches to health checks", async () => {
    const startTunnel = vi.fn()
      .mockRejectedValueOnce(new Error("edge is not ready"))
      .mockResolvedValueOnce({ running: true, publicUrl: "https://mouse.example.com" });
    const { supervisor, scheduled, schedule } = makeSupervisor({ startTunnel });

    await supervisor.start();
    expect(startTunnel).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenLastCalledWith(expect.any(Function), INITIAL_RETRY_DELAY_MS);

    await supervisor.check();
    expect(startTunnel).toHaveBeenCalledTimes(2);
    expect(schedule).toHaveBeenLastCalledWith(expect.any(Function), HEALTH_CHECK_DELAY_MS);
    expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([INITIAL_RETRY_DELAY_MS, HEALTH_CHECK_DELAY_MS]);
  });

  it("does not spawn cloudflared when the existing tunnel process is healthy", async () => {
    const startTunnel = vi.fn();
    const { supervisor, schedule } = makeSupervisor({
      getStatus: vi.fn().mockReturnValue({ running: true }),
      startTunnel,
    });

    await supervisor.start();

    expect(startTunnel).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenLastCalledWith(expect.any(Function), HEALTH_CHECK_DELAY_MS);
  });
});
