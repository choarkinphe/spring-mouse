// Independent processes avoid measuring the other revision's live cache.
// Synthetic messages only. Run: node --expose-gc scripts/benchmark-kiro-cache.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = new URL("../", import.meta.url);
const mode = process.argv[2];
if (!mode) {
  for (const revision of ["baseline", "working-tree"]) {
    process.stdout.write(execFileSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), revision], { cwd: root }));
  }
} else {
  const path = "open-sse/utils/kiroSessionReplay.js";
  const source = mode === "baseline"
    ? execFileSync("git", ["show", `c7a1e22:${path}`], { cwd: root, encoding: "utf8" })
    : readFileSync(new URL(path, root), "utf8");
  const loaded = source.replace('"../config/runtimeConfig.js"', JSON.stringify(new URL("open-sse/config/runtimeConfig.js", root).href));
  const api = await import(`data:text/javascript;base64,${Buffer.from(loaded).toString("base64")}`);
  global.gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 400; i++) {
    api.applyKiroSessionReplay({
      conversationId: `test-${i}`, connectionId: "fake", modelId: "m",
      currentMessage: { userInputMessage: { content: `${i}:` + "x".repeat(128 * 1024) } },
    });
  }
  global.gc();
  const retained = process.memoryUsage().heapUsed;
  const accounting = api.__test__?.cacheStats();
  api.clearKiroSessionReplayStore();
  global.gc();
  console.log(JSON.stringify({ mode, sessions: 400, heapDeltaMiB: +((retained - before) / 1024 / 1024).toFixed(2), afterClearDeltaMiB: +((process.memoryUsage().heapUsed - before) / 1024 / 1024).toFixed(2), accounting }));
}
