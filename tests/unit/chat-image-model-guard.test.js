import { beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_NATIVE_IMAGE_MODEL } from "open-sse/config/codexImage.js";

const mocks = vi.hoisted(() => ({
  credentials: vi.fn(), health: vi.fn(), core: vi.fn(),
  combo: vi.fn(), model: vi.fn(), entries: vi.fn(), comboByName: vi.fn(),
}));
vi.mock("@/sse/services/auth.js", () => ({
  extractApiKey: () => null, authorizeApiKey: async () => null,
  resolveApiKeyAccessTags: async () => [], getProviderCredentials: mocks.credentials,
  markAccountUnavailable: mocks.health, clearAccountError: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({}), getComboByName: mocks.comboByName, getCombos: async () => [],
}));
vi.mock("@/lib/apiKeyQuota.js", () => ({ getComboMemberQuotaGate: async () => null }));
vi.mock("@/sse/services/model.js", () => ({ getModelInfo: mocks.model, getComboModelEntries: mocks.entries }));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.core }));
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: () => null }));
vi.mock("open-sse/services/combo.js", async (original) => ({ ...await original(), handleComboChat: mocks.combo }));
vi.mock("@/lib/modelCapabilityOverrides", () => ({ refreshModelCapabilityOverrides: async () => {} }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn(async () => {}) }));
vi.mock("@/lib/networkTraffic.js", () => ({ getTrafficRequestId: () => null }));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  routeLine: vi.fn(), errorLine: vi.fn(), maskKey: (key) => key,
}));
import { handleChat } from "@/sse/handlers/chat.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.entries.mockResolvedValue(null);
  mocks.comboByName.mockResolvedValue(null);
  mocks.model.mockResolvedValue({ provider: "codex", model: CODEX_NATIVE_IMAGE_MODEL });
});

async function send(model, endpoint = "/v1/chat/completions") {
  const body = endpoint === "/v1/responses"
    ? { model, input: "draw a mouse", stream: true }
    : { model, messages: [{ role: "user", content: "draw a mouse" }], stream: true };
  return handleChat(new Request(`http://router.test${endpoint}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
}
async function expectRejected(response) {
  expect(response.status).toBe(400);
  expect((await response.json()).error.message).toContain("POST /v1/images/generations");
  expect(mocks.credentials).not.toHaveBeenCalled();
  expect(mocks.core).not.toHaveBeenCalled();
  expect(mocks.health).not.toHaveBeenCalled();
}

describe("image model guard at the resolved chat leaf", () => {
  it.each(["cx/gpt-image-2", "codex/gpt-image-2", "my-image-alias"])("rejects resolved native image model %s before account selection", async (model) => {
    await expectRejected(await send(model));
    expect(mocks.model).toHaveBeenCalledWith(model);
  });
  it("also rejects the Responses entry point", async () => {
    await expectRejected(await send("cx/gpt-image-2", "/v1/responses"));
  });
  it("rejects image leaves reached through a combo", async () => {
    mocks.entries.mockImplementation(async (name) => name === "picture-route" ? [{ model: "cx/gpt-image-2" }] : null);
    mocks.comboByName.mockResolvedValue({ name: "picture-route", models: ["cx/gpt-image-2"] });
    mocks.model.mockImplementation(async (id) => id === "picture-route"
      ? { provider: null, model: id }
      : { provider: "codex", model: CODEX_NATIVE_IMAGE_MODEL });
    mocks.combo.mockImplementation(({ body, handleSingleModel }) => handleSingleModel(body, "cx/gpt-image-2", {}));
    await expectRejected(await send("picture-route"));
    expect(mocks.combo).toHaveBeenCalledOnce();
  });
});
