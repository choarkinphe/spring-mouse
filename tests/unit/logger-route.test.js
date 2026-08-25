import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("request route logging", () => {
  let previousLogLevel;
  let logSpy;
  let logger;

  beforeEach(async () => {
    previousLogLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "WARN";
    vi.resetModules();
    logger = await import("../../src/sse/utils/logger.js");
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    if (previousLogLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previousLogLevel;
  });

  it("keeps model routing visible while ordinary info lines stay suppressed", () => {
    logger.line("🟢", "📊", "ordinary lifecycle line");
    expect(logSpy).not.toHaveBeenCalled();

    logger.routeLine("🟢", "▶", "POST combo → openai/gpt-5");

    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\] 🟢 ▶ POST combo → openai\/gpt-5$/),
    );
  });
});
