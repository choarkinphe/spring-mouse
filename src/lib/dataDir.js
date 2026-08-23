import fs from "node:fs";
import path from "path";
import os from "os";

const APP_NAME = "spring-mouse";
const LEGACY_APP_NAME = "spring-mouse";

function defaultDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
  }
  return path.join(os.homedir(), `.${APP_NAME}`);
}

// One-time migration ~/.spring-mouse (legacy ~/.9router) (project rename).
// Keeps working: rename on the same filesystem, recursive copy across
// devices (legacy dir is then left in place as a backup).
function migrateLegacyDir(newDir) {
  const legacyDir = process.platform === "win32"
    ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), LEGACY_APP_NAME)
    : path.join(os.homedir(), `.${LEGACY_APP_NAME}`);
  if (fs.existsSync(newDir) || !fs.existsSync(legacyDir)) return;
  try {
    fs.renameSync(legacyDir, newDir);
    console.log(`[DATA_DIR] migrated ${legacyDir} -> ${newDir}`);
  } catch {
    try {
      fs.cpSync(legacyDir, newDir, { recursive: true });
      console.log(`[DATA_DIR] copied ${legacyDir} -> ${newDir} (legacy dir kept as backup)`);
    } catch (e) {
      console.warn(`[DATA_DIR] legacy migration failed (${e.message}); starting fresh at ${newDir}`);
    }
  }
}

export function getDataDir() {
  const configured = process.env.DATA_DIR;
  if (!configured) {
    const dir = defaultDir();
    migrateLegacyDir(dir);
    return dir;
  }

  // On Windows, ignore Unix-style absolute paths (e.g. /var/lib/...) that come
  // from a Linux-targeted .env or Docker config — they are not valid here.
  if (process.platform === "win32" && /^\//.test(configured)) {
    console.warn(`[DATA_DIR] '${configured}' is a Unix path on Windows → fallback to default`);
    return defaultDir();
  }

  try {
    fs.mkdirSync(configured, { recursive: true });
    return configured;
  } catch (e) {
    if (e?.code === "EACCES" || e?.code === "EPERM") {
      console.warn(`[DATA_DIR] '${configured}' not writable → fallback ~/.${APP_NAME}`);
      return defaultDir();
    }
    throw e;
  }
}

export const DATA_DIR = getDataDir();
