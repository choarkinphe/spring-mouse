import { describe, it, expect, beforeEach, vi } from "vitest";

const { createProviderConnection } = vi.hoisted(() => ({
  createProviderConnection: vi.fn(async (data) => ({ id: "test-connection", ...data })),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) => new Response(JSON.stringify(body), {
      status: init.status || 200,
      headers: { "Content-Type": "application/json" },
    }),
  },
}));
vi.mock("@/models", () => ({
  createProviderConnection,
  getProviderConnections: vi.fn(),
  getAvailableMouseById: vi.fn(),
  getProviderNodeById: vi.fn(),
  getProviderNodes: vi.fn(),
  getApiKeys: vi.fn(),
}));
vi.mock("@/app/api/v1/models/route", () => ({ buildModelsList: vi.fn() }));
vi.mock("@/lib/db/driver.js", () => ({ getAdapter: vi.fn() }));

import { POST } from "@/app/api/providers/route.js";

function request(body) {
  return new Request("http://localhost/api/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("no-auth provider creation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates OpenCode Free without an API key using its default name", async () => {
    const response = await POST(request({ provider: "opencode" }));
    expect(response.status).toBe(201);
    expect(createProviderConnection).toHaveBeenCalledWith(expect.objectContaining({
      provider: "opencode",
      name: "OpenCode Free",
      authType: "none",
      apiKey: "",
      isActive: true,
    }));
    const { connection } = await response.json();
    expect(connection.id).toBe("test-connection");
    expect(connection).not.toHaveProperty("apiKey");
  });

  it("accepts the empty-key payload from the drawer", async () => {
    const response = await POST(request({ provider: "opencode", apiKey: "", name: "OpenCode Free", priority: 1 }));
    expect(response.status).toBe(201);
    expect(createProviderConnection).toHaveBeenCalledOnce();
  });

  it.each(["nvidia", "opencode-go"])("still requires an API key for %s", async (provider) => {
    const response = await POST(request({ provider, noAuth: true }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "API Key is required" });
    expect(createProviderConnection).not.toHaveBeenCalled();
  });

  it("does not accept an unknown provider claiming to be no-auth", async () => {
    const response = await POST(request({ provider: "unknown-provider", noAuth: true }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid provider" });
    expect(createProviderConnection).not.toHaveBeenCalled();
  });
});
