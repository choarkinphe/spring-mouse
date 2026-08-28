// Migration registry — append new entries when schema changes.
// Each migration: { version: number, name: string, up(db): void }
// Versions MUST be unique and monotonically increasing.
import m001 from "./001-initial.js";
import m002 from "./002-remove-proxy-pools.js";
import m003 from "./003-remove-sso-settings.js";
import m004 from "./004-secure-usage-request-lifecycle.js";
import m005 from "./005-api-key-quota.js";
import m006 from "./006-api-key-quota-mode.js";
import m007 from "./007-api-key-quota-reset.js";
import m008 from "./008-api-key-quota-window-resets.js";
import m009 from "./009-api-key-quota-scheduled-resets.js";
import m010 from "./010-combo-capabilities.js";
import m011 from "./011-open-platform-api-keys.js";
import m012 from "./012-open-platform-call-logs.js";

export const MIGRATIONS = [m001, m002, m003, m004, m005, m006, m007, m008, m009, m010, m011, m012].sort((a, b) => a.version - b.version);

export function latestVersion() {
  return MIGRATIONS.length ? MIGRATIONS[MIGRATIONS.length - 1].version : 0;
}
