import { describe, expect, it } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_OAUTH } from "../../open-sse/config/providers.js";
import { OAUTH_PROVIDERS, supportsLiveModelSync } from "../../src/shared/constants/providers.js";
import { getProviderIconSrc } from "../../src/shared/utils/providerIcon.js";
import { supportsMouseExecution } from "../../src/shared/constants/mouseSupport.js";

describe("Devin provider wiring", () => {
  it("exposes direct inference independently of the disabled local agent", () => {
    const provider = REGISTRY.find(p => p.id === "devin");
    expect(provider.category).toBe("oauth");
    expect(provider.transport.format).toBe("openai");
    expect(provider.transport.forceStream).toBe(true);
    expect(provider.transport.baseUrl).toBe("https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage");
    expect(provider.models).toEqual([]);
    expect(REGISTRY.some(p => p.id === "devin-cli")).toBe(false);
    expect(PROVIDERS.devin).toBeDefined();
    expect(OAUTH_PROVIDERS.devin).toBeDefined();
    expect(PROVIDER_OAUTH.devin.tokenUrl).toBe("https://server.codeium.com/exa.seat_management_pb.SeatManagementService/ExchangeDevinCLIPKCECode");
    expect(supportsLiveModelSync("devin")).toBe(true);
    expect(getProviderIconSrc("devin")).toBe("/providers/devin-cli.png");
    expect(supportsMouseExecution("devin")).toBe(false);
  });
});
