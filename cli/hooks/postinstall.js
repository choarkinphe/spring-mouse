#!/usr/bin/env node

// Postinstall: warm-up SQLite deps into ~/.spring-mouse/runtime so the first
// `spring-mouse` start doesn't need network. Failure here is non-fatal —
// cli.js will retry at runtime if anything is missing.
const { ensureSqliteRuntime } = require("./sqliteRuntime");
const { ensureTrayRuntime } = require("./trayRuntime");

try {
  ensureSqliteRuntime({ silent: false });
  console.log("[spring-mouse] runtime SQLite deps ready");
} catch (e) {
  console.warn(`[spring-mouse] runtime warm-up skipped: ${e.message}`);
}

try {
  ensureTrayRuntime({ silent: false });
} catch (e) {
  console.warn(`[spring-mouse] tray runtime skipped: ${e.message}`);
}

process.exit(0);
