import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ NextResponse: { json: (body, init = {}) => Response.json(body, init) } }));
vi.mock("@/models", () => ({ getProviderNodeById: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ getProviderConnectionById: vi.fn(), updateProviderConnection: vi.fn() }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn(async () => ({ connectionProxyEnabled: false })) }));

import { POST } from "../../src/app/api/providers/validate/route.js";
import { testSingleConnection } from "../../src/app/api/providers/[id]/test/testUtils.js";
import { getProviderConnectionById, updateProviderConnection } from "@/lib/localDb";

const endpoint = "https://opencode.ai/inference/go/openai/v1/chat/completions";

beforeEach(() => {
  vi.clearAllMocks();
  getProviderConnectionById.mockResolvedValue({ id: "go-probe", provider: "opencode-go", authType: "apikey", apiKey: "test-only-key" });
});
afterEach(() => vi.unstubAllGlobals());

async function validate() {
  const response = await POST(new Request("http://localhost/api/providers/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "opencode-go", apiKey: "test-only-key" }),
  }));
  return response.json();
}

for (const [name, run] of [["new key validation", validate], ["saved connection test", () => testSingleConnection("go-probe")]]) {
  describe(`OpenCode Go ${name}`, () => {
    it("sends honest client identification and a stable probe session to the documented endpoint", async () => {
      const fetchMock = vi.fn(async () => Response.json({ choices: [{ message: { content: "ok" } }] }));
      vi.stubGlobal("fetch", fetchMock);
      expect((await run()).valid).toBe(true);
      expect((await run()).valid).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const [url, options] of fetchMock.mock.calls) {
        expect(url).toBe(endpoint);
        expect(options.headers).toMatchObject({
          Authorization: "Bearer test-only-key",
          "User-Agent": expect.stringMatching(/^Spring-Mouse\//),
          "x-opencode-session": "spring-mouse-connection-test",
        });
        expect(JSON.parse(options.body)).toMatchObject({ stream: false, messages: [{ role: "user", content: "ping" }] });
      }
    });

    it.each([400, 401, 403, 404, 429, 500, 503])("does not treat HTTP %s as a working connection", async (status) => {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { type: "MissingSessionID", message: "fixture rejection" } }, { status })));
      const result = await run();
      expect(result.valid).toBe(false);
      expect(result.error).toBe(`OpenCode Go returned HTTP ${status}`);
      if (name === "saved connection test") {
        expect(updateProviderConnection).toHaveBeenCalledWith("go-probe", expect.objectContaining({
          testStatus: "error", lastError: `OpenCode Go returned HTTP ${status}`,
        }));
      }
    });
  });
}
