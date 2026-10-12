import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = await mkdtemp(path.join(tmpdir(), "spring-mouse-systemone-access-"));
let GET, PATCH;
beforeAll(async () => ({ GET, PATCH } = await import("@/app/api/settings/route.js")));
const request = (body) => new Request("http://localhost/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("System One access settings", () => {
  it("defaults to no additional interface restriction", async () => {
    expect((await (await GET()).json()).systemoneAccessTags).toEqual([]);
  });
  it("persists normalized tags without changing key/model permissions", async () => {
    await PATCH(request({ modelAccessTags: { "openai/model": ["chat"] }, apiKeyAccessTags: { fixture: ["team-a"] } }));
    const response = await PATCH(request({ systemoneAccessTags: [" TEAM-A ", "team-a", "Decisions"] }));
    expect(response.status).toBe(200);
    expect((await response.json()).systemoneAccessTags).toEqual(["team-a", "decisions"]);
    const stored = await (await GET()).json();
    expect(stored.systemoneAccessTags).toEqual(["team-a", "decisions"]);
    expect(stored.modelAccessTags).toEqual({ "openai/model": ["chat"] });
    expect(stored.apiKeyAccessTags).toEqual({ fixture: ["team-a"] });
  });
  it.each([null, "team-a", {}, [null], [42], [""], ["   "]])("rejects malformed policy without silently opening access %#", async (value) => {
    await PATCH(request({ systemoneAccessTags: ["restricted"] }));
    expect((await PATCH(request({ systemoneAccessTags: value }))).status).toBe(400);
    expect((await (await GET()).json()).systemoneAccessTags).toEqual(["restricted"]);
  });
  it("allows explicitly clearing the policy", async () => {
    expect((await PATCH(request({ systemoneAccessTags: [] }))).status).toBe(200);
    expect((await (await GET()).json()).systemoneAccessTags).toEqual([]);
  });
});
