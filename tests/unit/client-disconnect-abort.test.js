import { describe, expect, it, vi } from "vitest";

import { createStreamController } from "../../open-sse/utils/streamHandler.js";

describe("client disconnect cancellation", () => {
  it("aborts the upstream signal before a response stream exists", () => {
    const client = new AbortController();
    const onDisconnect = vi.fn();
    const controller = createStreamController({
      clientSignal: client.signal,
      onDisconnect,
      provider: "test-provider",
      model: "test-model",
      log: {},
    });

    expect(controller.signal.aborted).toBe(false);
    client.abort("client socket closed");

    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe("client socket closed");
    expect(controller.isConnected()).toBe(false);
    expect(onDisconnect).toHaveBeenCalledWith(expect.objectContaining({ reason: "client socket closed" }));
  });

  it("handles a request already aborted before controller creation", () => {
    const client = new AbortController();
    client.abort("client already gone");

    const controller = createStreamController({
      clientSignal: client.signal,
      provider: "test-provider",
      model: "test-model",
      log: {},
    });

    expect(controller.signal.aborted).toBe(true);
    expect(controller.isConnected()).toBe(false);
  });

  it("removes the client abort listener after normal completion", () => {
    const client = new AbortController();
    const onDisconnect = vi.fn();
    const controller = createStreamController({
      clientSignal: client.signal,
      onDisconnect,
      provider: "test-provider",
      model: "test-model",
      log: {},
    });

    controller.handleComplete();
    client.abort("late client close");

    expect(onDisconnect).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(false);
  });
});
