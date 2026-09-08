import { describe, expect, it, vi } from "vitest";

import { runWithAbortDeadline } from "../../open-sse/utils/abortable.js";

describe("runWithAbortDeadline", () => {
  it("rejects immediately when the client aborts", async () => {
    const client = new AbortController();
    const pending = runWithAbortDeadline(
      () => new Promise(() => {}),
      { signal: client.signal, timeoutMs: 10_000 },
    );

    client.abort("client disconnected");

    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "client disconnected" });
  });

  it("runs the resource cleanup hook before returning a timeout", async () => {
    const onTimeout = vi.fn();

    await expect(runWithAbortDeadline(
      () => new Promise(() => {}),
      { timeoutMs: 20, timeoutMessage: "response body stalled", onTimeout },
    )).rejects.toMatchObject({ name: "TimeoutError", message: "response body stalled" });

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});
