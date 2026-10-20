import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/localDb", () => ({ getApiKeys: vi.fn(async () => [{ key: "test-only", isActive: true }]) }));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: vi.fn(async () => "fixture-machine-id") }));

import { pingModelByKind } from "../../src/app/api/models/test/ping.js";

afterEach(() => vi.unstubAllGlobals());

describe("OpenCode Go model connectivity probe", () => {
  it("sends an honest UA and a unique session for each isolated probe turn", async () => {
    const requests = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
      requests.push(options);
      return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
    }));

    const first = await pingModelByKind("opencode-go/glm-5.2", "llm", "http://spring-mouse.test");
    const second = await pingModelByKind("opencode-go/glm-5.2", "llm", "http://spring-mouse.test");

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(requests).toHaveLength(2);
    const sessions = requests.map(({ headers }) => headers["x-opencode-session"]);
    expect(sessions.every((session) => /^spring-mouse-model-test-[0-9a-f-]{36}$/.test(session))).toBe(true);
    expect(new Set(sessions).size).toBe(2);
    for (const { headers, body } of requests) {
      expect(headers).toMatchObject({
        Authorization: "Bearer test-only",
        "User-Agent": expect.stringMatching(/^Spring-Mouse\//),
        "x-9r-cli-token": "fixture-machine-id",
      });
      expect(JSON.parse(body)).toMatchObject({
        model: "opencode-go/glm-5.2",
        messages: [{ role: "user", content: "hi" }],
      });
    }
  });
});
