// Restores the database from the litestream replica.
//
// ⚠️ WHY THIS CANNOT SIMPLY OVERWRITE data.sqlite IN PLACE:
// the Next server and runtime/usage-writer.mjs both hold the database open, and
// SQLite identifies an open database by inode. Writing a new file over the path
// leaves both processes reading the OLD inode — the app would keep serving (and
// writing) pre-restore data while the restored file sits unused on disk. That is
// the "restore appeared to work but nothing changed" failure, and it is silent.
//
// So the restore is split: this module downloads and verifies a replacement into
// a staging path and records intent in a marker file. runtime/entrypoint.sh
// performs the swap on the next boot, before any process opens the database.
// The caller then exits the process and the container's `restart: always`
// policy brings it back. From the UI this is one button plus a short wait.
//
// The staging file is verified with PRAGMA integrity_check BEFORE the marker is
// written: a truncated or corrupt download must never become the database on
// the next boot, when nobody is watching.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DATA_FILE } from "@/lib/db/paths.js";
import { BACKUP_DIR, LITESTREAM_BIN, resolveActiveDestination, stopLitestream, writeConfigIfNeeded } from "./litestream.js";
import { buildEnv } from "./litestreamConfig.js";

export const STAGING_FILE = path.join(BACKUP_DIR, "restore-staging.sqlite");
export const MARKER_FILE = path.join(BACKUP_DIR, "restore-pending.json");

// ⚠️ THE BOOT SWAP IS A CONTAINER FEATURE. Outside the Docker image nothing
// performs it: runtime/entrypoint.sh is the ENTRYPOINT there, and `restart:
// always` is what brings the process back. On a bare `npm run start` deployment
// a restore would stage a snapshot, exit the server, and simply stay down —
// with a marker left on disk that a much later Docker boot would then apply
// unexpectedly. The image sets this variable; a custom deployment that
// implements its own swap can set it too.
export function canSwapOnBoot() {
  return process.env.SPRING_MOUSE_BOOT_RESTORE === "1";
}

const NO_SWAP_MESSAGE =
  "Restore from the dashboard requires the Docker deployment (runtime/entrypoint.sh performs the swap on restart). " +
  "On this deployment, stop the service and restore the SQLite file manually instead.";

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => { stdout += c.toString(); });
    child.stderr?.on("data", (c) => { stderr += c.toString(); });
    child.once("error", (error) => resolve({ code: -1, stdout, stderr: stderr + error.message }));
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

// Read a single PRAGMA from a database file without loading the whole thing.
async function checkIntegrity(filePath) {
  const script = `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    const row = db.prepare("PRAGMA integrity_check").get();
    const value = row ? Object.values(row)[0] : "no result";
    console.log(value);
  `;
  const result = await run(process.execPath, ["-e", script, filePath]);
  if (result.code !== 0) return { ok: false, detail: result.stderr.trim() || `exit ${result.code}` };
  const value = result.stdout.trim();
  return { ok: value === "ok", detail: value };
}

// Download the replica into the staging file. `timestamp` restores as of a
// point in time when provided.
export async function stageRestore({ settings = null, timestamp = "" } = {}) {
  const { destination, secret, databasePath } = await resolveActiveDestination(settings);
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  try { fs.rmSync(STAGING_FILE, { force: true }); } catch {}

  const env = buildEnv({ ...destination, secret });
  const args = ["restore"];
  if (destination.type === "url") {
    // Legacy shape: the plain URL carries everything, and litestream refuses
    // "-config" together with a positional replica URL. Passing the URL keeps
    // pre-existing installs on the exact path they have always used.
    args.push("-o", STAGING_FILE);
    if (timestamp) args.push("-timestamp", String(timestamp));
    args.push(destination.config.url);
  } else {
    // Typed destinations use the FIELD form, whose extra parameters (sftp
    // key-path, s3 endpoint, …) live only in the config file. litestream then
    // takes the DATABASE PATH positionally, which must match the config's
    // `path:` — it does, because both are DATA_FILE.
    const configPath = writeConfigIfNeeded({ ...destination, secret });
    args.push("-config", configPath, "-o", STAGING_FILE);
    if (timestamp) args.push("-timestamp", String(timestamp));
    args.push(databasePath);
  }

  const result = await run(LITESTREAM_BIN, args, { env });
  if (result.code !== 0 || !fs.existsSync(STAGING_FILE)) {
    return {
      ok: false,
      error: (result.stderr.trim() || result.stdout.trim() || `litestream restore exited ${result.code}`).slice(-600),
    };
  }

  const integrity = await checkIntegrity(STAGING_FILE);
  if (!integrity.ok) {
    try { fs.rmSync(STAGING_FILE, { force: true }); } catch {}
    return { ok: false, error: `Restored file failed integrity_check: ${integrity.detail}` };
  }

  return { ok: true, bytes: fs.statSync(STAGING_FILE).size };
}

// Record the intent to swap on next boot. Written only after the staging file
// passed verification.
export function markRestorePending({ requestedBy = "dashboard" } = {}) {
  if (!fs.existsSync(STAGING_FILE)) throw new Error("No verified restore is staged");
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.writeFileSync(
    MARKER_FILE,
    JSON.stringify({ stagedFile: STAGING_FILE, target: DATA_FILE, requestedAt: new Date().toISOString(), requestedBy }, null, 2),
    { mode: 0o600 },
  );
  return MARKER_FILE;
}

export function clearRestoreMarker() {
  try { fs.unlinkSync(MARKER_FILE); } catch (error) { if (error?.code !== "ENOENT") throw error; }
}

export function getRestoreState() {
  let pending = null;
  try { pending = JSON.parse(fs.readFileSync(MARKER_FILE, "utf8")); } catch {}
  return {
    pending: Boolean(pending),
    pendingSince: pending?.requestedAt ?? null,
    staged: fs.existsSync(STAGING_FILE),
    stagedBytes: fs.existsSync(STAGING_FILE) ? fs.statSync(STAGING_FILE).size : 0,
    // The UI disables the restore button when this is false, so the operator
    // gets an explanation instead of a dead service.
    canSwapOnBoot: canSwapOnBoot(),
  };
}

// Full restore: stop replication, download, verify, mark. The caller is
// responsible for exiting the process afterwards so entrypoint can swap.
export async function performRestore({ settings = null, timestamp = "" } = {}) {
  // Checked BEFORE downloading: staging a snapshot this deployment cannot
  // apply would leave a marker behind that a later Docker boot might act on.
  if (!canSwapOnBoot()) return { ok: false, error: NO_SWAP_MESSAGE };

  stopLitestream();
  const staged = await stageRestore({ settings, timestamp });
  if (!staged.ok) return staged;
  markRestorePending();
  return { ...staged, marker: MARKER_FILE, target: DATA_FILE };
}
