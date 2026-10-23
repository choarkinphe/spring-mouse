import { describe, expect, it } from "vitest";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { buildOpenCodeGoHeaders } from "../../open-sse/utils/opencodeGoHeaders.js";
import pkg from "../../package.json" with { type: "json" };

const springMouseUa = `Spring-Mouse/${pkg.version}`;

describe("OpenCode Go identity headers", () => {
  it("preserves native OpenCode session identity and a truthful client User-Agent", () => {
    const rawHeaders = new Headers({
      "User-Agent": "MyCodingAgent/1.0",
      "x-opencode-session": "ses_native-conversation-123",
    });
    const identity = buildOpenCodeGoHeaders({ headers: rawHeaders });
    expect(identity).toEqual({
      "User-Agent": "MyCodingAgent/1.0",
      "x-opencode-session": "ses_native-conversation-123",
    });
  });

  it("derives stable opaque session IDs from explicit conversation metadata", () => {
    const body = { conversation_id: "private-conversation-id" };
    const first = buildOpenCodeGoHeaders({ body });
    const second = buildOpenCodeGoHeaders({ body: { ...body } });
    expect(first).toEqual(second);
    expect(first["x-opencode-session"]).toMatch(/^sm_[a-f0-9]{64}$/);
    expect(first["x-opencode-session"]).not.toContain("private-conversation-id");
  });

  it("does not invent sessions from request IDs, messages, or missing metadata", () => {
    const identity = buildOpenCodeGoHeaders({
      headers: { "x-client-request-id": "request-only" },
      body: { messages: [{ role: "user", content: "private prompt" }] },
    });
    expect(identity["x-opencode-session"]).toBeUndefined();
    expect(identity["User-Agent"]).toBe(springMouseUa);
  });

  it("rejects unsafe native header values and generic HTTP-library User-Agents", () => {
    const identity = buildOpenCodeGoHeaders({
      headers: {
        "user-agent": "undici/7.0",
        "x-opencode-session": "bad\r\nvalue",
      },
    });
    expect(identity["User-Agent"]).toBe(springMouseUa);
    expect(identity["x-opencode-session"]).toBeUndefined();
  });

  it("uses captured pre-translation metadata without leaking the original user ID", () => {
    const originalBody = { metadata: { user_id: JSON.stringify({ session_id: "conversation-1", account_id: "private-account" }) } };
    const captured = buildOpenCodeGoHeaders({ body: originalBody });
    const executor = new DefaultExecutor("opencode-go");
    const headers = executor.buildHeaders({ apiKey: "test-key", opencodeGoHeaders: captured }, false);
    expect(headers["x-opencode-session"]).toMatch(/^sm_[a-f0-9]{64}$/);
    expect(headers["x-opencode-session"]).toBe(captured["x-opencode-session"]);
    expect(JSON.stringify(headers)).not.toContain("private-account");
  });

  it("adds the Go identity to outgoing authorization headers", () => {
    const executor = new DefaultExecutor("opencode-go");
    const headers = executor.buildHeaders({
      apiKey: "test-key",
      rawHeaders: { "x-opencode-session": "stable-native-id" },
    }, true);

    expect(headers).toMatchObject({
      Authorization: "Bearer test-key",
      "User-Agent": springMouseUa,
      "x-opencode-session": "stable-native-id",
      Accept: "text/event-stream",
    });
  });
});
