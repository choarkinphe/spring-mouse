import { cpSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export function copyStandaloneAssets({ projectRoot = process.cwd(), distDir = process.env.NEXT_DIST_DIR || ".next" } = {}) {
  if (process.env.NEXT_TRACING_ROOT_MODE === "workspace") {
    console.log("[standalone-assets] Skipping workspace-traced CLI build; CLI packaging handles assets");
    return;
  }

  const buildDir = resolve(projectRoot, distDir);
  const standaloneDir = resolve(buildDir, "standalone");

  if (!existsSync(standaloneDir)) {
    console.log(`[standalone-assets] No standalone build found at ${standaloneDir}`);
    return;
  }

  const staticSource = resolve(buildDir, "static");
  const staticDestination = resolve(standaloneDir, distDir, "static");
  if (existsSync(staticSource)) {
    cpSync(staticSource, staticDestination, { recursive: true, force: true });
    console.log(`[standalone-assets] Copied static assets to ${staticDestination}`);
  }

  const publicSource = resolve(projectRoot, "public");
  const publicDestination = resolve(standaloneDir, "public");
  if (existsSync(publicSource)) {
    cpSync(publicSource, publicDestination, { recursive: true, force: true });
    console.log(`[standalone-assets] Copied public assets to ${publicDestination}`);
  }

  // Without it beside server.js the standalone build serves requests unsanitized.
  const serverWrapperSource = resolve(projectRoot, "custom-server.js");
  const serverWrapperDestination = resolve(standaloneDir, "custom-server.js");
  if (existsSync(serverWrapperSource)) {
    cpSync(serverWrapperSource, serverWrapperDestination, { force: true });
    console.log(`[standalone-assets] Copied custom-server.js to ${serverWrapperDestination}`);
  }

  // The SQLite adapter deliberately shares the standalone workers' synchronous
  // transaction implementation through a source-file import. Next preserves
  // that external runtime path instead of bundling it, so ship it explicitly.
  const sqliteTransactionSource = resolve(projectRoot, "runtime", "sqlite-transaction.mjs");
  const sqliteTransactionDestination = resolve(standaloneDir, "runtime", "sqlite-transaction.mjs");
  if (existsSync(sqliteTransactionSource)) {
    mkdirSync(dirname(sqliteTransactionDestination), { recursive: true });
    cpSync(sqliteTransactionSource, sqliteTransactionDestination, { force: true });
    console.log(`[standalone-assets] Copied the SQLite transaction helper to ${sqliteTransactionDestination}`);
  }

  // Nodes download their runtime from /api/mouses/agent, and that route reads the
  // file from disk instead of importing it, so tracing cannot see it.
  const mouseAgentSource = resolve(projectRoot, "mouse", "agent.mjs");
  const mouseAgentDestination = resolve(standaloneDir, "mouse", "agent.mjs");
  if (existsSync(mouseAgentSource)) {
    mkdirSync(dirname(mouseAgentDestination), { recursive: true });
    cpSync(mouseAgentSource, mouseAgentDestination, { force: true });
    console.log(`[standalone-assets] Copied the mouse agent to ${mouseAgentDestination}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(dirname(fileURLToPath(import.meta.url)), "copy-standalone-assets.mjs")) {
  copyStandaloneAssets();
}
