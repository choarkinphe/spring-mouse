import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "sm-usage-err-"));
process.env.DATA_DIR = dir;
process.env.USAGE_WRITER_DISABLED = "1";

const { saveRequestUsage } = await import("../../src/lib/db/repos/usageRepo.js");
const { getAdapter } = await import("../../src/lib/db/driver.js");
const { GET } = await import("../../src/app/api/usage/internal-stats/route.js");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("failed usage rows carry their reason end to end", () => {
  it("stores only a fixed label in SQLite and the ring, and does not expose legacy raw text", async () => {
    const sentinel = "private-prompt-and-signed-url-sentinel";
    const body = JSON.stringify({ type: "error", error: { message: `Claude Code 2.1.92 does not support this model: ${sentinel}` } });
    await saveRequestUsage({ requestId: "fail-1", provider: "claude", model: "claude-opus-5-5", status: "upstream:400", error: body, tokens: {} });
    await saveRequestUsage({ requestId: "ok-1", provider: "claude", model: "claude-opus-5-5", status: "success", error: "should not be stored", tokens: { prompt_tokens: 1, completion_tokens: 1 } });

    const db = await getAdapter();
    const read = (id) => JSON.parse(db.get("SELECT meta FROM usageHistory WHERE requestId = ?", [id])?.meta || "{}");
    // The usage writer may persist asynchronously; give it a moment.
    for (let i = 0; i < 20 && !db.get("SELECT 1 FROM usageHistory WHERE requestId = 'ok-1'"); i++) await new Promise((r) => setTimeout(r, 50));
    expect(read("fail-1").error).toBe("Upstream rejected the Claude Code version");
    expect(read("ok-1")).not.toHaveProperty("error");
    expect(global._recentRing.items.find((entry) => entry.requestId === "fail-1").error)
      .toBe("Upstream rejected the Claude Code version");

    await saveRequestUsage({ requestId: "legacy-1", model: "example", status: "upstream:502", tokens: {} });
    db.run("UPDATE usageHistory SET meta = ? WHERE requestId = ?", [JSON.stringify({ error: sentinel }), "legacy-1"]);
    const response = await GET(new Request("http://x/api/usage/internal-stats"));
    expect(response.status).toBe(200);
    const stats = await response.json();
    expect(stats.recent.find((r) => r.id === "fail-1").error).toBe("Upstream rejected the Claude Code version");
    expect(stats.recent.find((r) => r.id === "ok-1").error).toBeNull();
    expect(stats.recent.find((r) => r.id === "legacy-1").error).toBeNull();
    expect(JSON.stringify(stats)).not.toContain(sentinel);
  });
});
