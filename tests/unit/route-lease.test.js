import { describe, it, expect, vi } from "vitest";
import { withRouteLease } from "../../src/sse/services/routeLease.js";
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("account lease owns complete request lifecycle", () => {
  it("releases on token refresh/setup exceptions", async () => {
    const release = vi.fn();
    await expect(withRouteLease(release, null, async () => { throw new Error("refresh failed"); })).rejects.toThrow("refresh failed");
    await settle(); expect(release).toHaveBeenCalledOnce();
  });
  it("holds the lease past headers and releases exactly once at EOF", async () => {
    const release = vi.fn(); let source;
    const signal = new AbortController();
    const result = await withRouteLease(release, signal.signal, async () => ({ success: true,
      response: new Response(new ReadableStream({ start(c) { source = c; } }), { headers: { "content-type": "text/event-stream" } }),
    }));
    expect(release).not.toHaveBeenCalled();
    source.enqueue(new TextEncoder().encode("data: token\n\n")); source.close();
    expect(await result.response.text()).toBe("data: token\n\n");
    signal.abort(); await settle(); expect(release).toHaveBeenCalledOnce();
  });
  it("releases failed/bypass responses without a controller callback", async () => {
    const release = vi.fn();
    await withRouteLease(release, null, async () => ({ success: false, response: new Response("bad", {status: 502}) }));
    await settle(); expect(release).toHaveBeenCalledOnce();
  });
  it("cancels upstream and releases on downstream cancel", async () => {
    const release = vi.fn(), cancel = vi.fn();
    const result = await withRouteLease(release, null, async () => ({ success: true, response: new Response(new ReadableStream({cancel})) }));
    await result.response.body.cancel("gone"); await settle();
    expect(cancel).toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
  });
  it("releases a stalled setup immediately when the client aborts", async () => {
    const release = vi.fn(); const controller = new AbortController(); let finish;
    const pending = withRouteLease(release, controller.signal, () => new Promise((resolve) => { finish = resolve; }));
    controller.abort(); await settle(); expect(release).toHaveBeenCalledOnce();
    finish({ success: false }); await pending;
    expect(release).toHaveBeenCalledOnce();
  });
  it("does not execute a request already aborted before setup", async () => {
    const release = vi.fn(), execute = vi.fn(); const controller = new AbortController(); controller.abort();
    await expect(withRouteLease(release, controller.signal, execute)).rejects.toMatchObject({name: "AbortError"});
    await settle(); expect(release).toHaveBeenCalledOnce(); expect(execute).not.toHaveBeenCalled();
  });
  it("releases on a broken upstream body without masking the error", async () => {
    const release = vi.fn();
    const result = await withRouteLease(release, null, async () => ({success: true, response: new Response(new ReadableStream({start(c) { c.error(new Error("socket")); }}))}));
    await expect(result.response.text()).rejects.toThrow("socket");
    await settle(); expect(release).toHaveBeenCalledOnce();
  });
});
