import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCloudflareTunnelStatus,
  refreshCloudflareTunnelConnection,
} from "@/lib/tunnel/cloudflare/cloudflared";

const runtime = globalThis.__springMouseCloudflareTunnel;
const originalChild = runtime.child;

afterEach(() => {
  runtime.child = originalChild;
  runtime.connected = false;
});

describe("Cloudflare Tunnel Edge connection status", () => {
  it("marks a running tunnel connected only when /ready returns 200", async () => {
    runtime.child = { pid: 12345, exitCode: null, killed: false };
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200 });

    await expect(refreshCloudflareTunnelConnection({ fetchImpl })).resolves.toBe(true);
    expect(getCloudflareTunnelStatus()).toMatchObject({ running: true, connected: true });
  });

  it("marks a live process disconnected when /ready is not healthy", async () => {
    runtime.child = { pid: 12345, exitCode: null, killed: false };
    const fetchImpl = vi.fn().mockResolvedValue({ status: 503 });

    await expect(refreshCloudflareTunnelConnection({ fetchImpl })).resolves.toBe(false);
    expect(getCloudflareTunnelStatus()).toMatchObject({ running: true, connected: false });
  });

  it("does not probe readiness when cloudflared is not running", async () => {
    runtime.child = null;
    const fetchImpl = vi.fn();

    await expect(refreshCloudflareTunnelConnection({ fetchImpl })).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
