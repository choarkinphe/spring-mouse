import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseTOML } from "confbox";
const state = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, default: { ...actual.default, homedir: () => state.home } };
});
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, default: { ...actual.default, homedir: () => state.home } };
});
const { apply, reset } = await import("../../setup-cli/lib/tools/codex.js");
let root;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "sm-codex-setup-test.")); state.home = root; });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
describe("Codex setup native images", () => {
  it("sets provider gate and durable SM authentication without changing unrelated config", async () => {
    const dir = path.join(root, ".codex"); await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "config.toml"), 'model_reasoning_effort = "high"\n[model_providers.other]\nname = "Other"\n');
    const result = await apply({ endpoint: "http://localhost:8008", key: "fixture-only", model: "chat-route" });
    const parsed = parseTOML(await fs.readFile(result.file, "utf8"));
    expect(parsed.model).toBe("chat-route");
    expect(parsed.model_provider).toBe("spring-mouse");
    expect(parsed.agents.subagent.description).toBe("Spring Mouse subagent");
    expect(parsed.model_reasoning_effort).toBe("high");
    expect(parsed.model_providers.other.name).toBe("Other");
    expect(parsed.model_providers["spring-mouse"]).toMatchObject({ base_url: "http://localhost:8008/v1", wire_api: "responses", requires_openai_auth: false, experimental_bearer_token: "fixture-only", http_headers: { "x-openai-actor-authorization": "sm-native-image-tool" } });
    expect(JSON.parse(await fs.readFile(result.authFile, "utf8"))).toMatchObject({ OPENAI_API_KEY: "fixture-only", auth_mode: "apikey" });
    if (process.platform !== "win32") {
      expect((await fs.stat(result.file)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(result.authFile)).mode & 0o777).toBe(0o600);
    }
    await reset();
    expect(parseTOML(await fs.readFile(result.file, "utf8")).model_providers["spring-mouse"]).toBeUndefined();
  });
});
