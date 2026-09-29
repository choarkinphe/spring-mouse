// Manages the litestream child process — the actual replication engine.
//
// MODELED ON src/lib/tunnel/cloudflare/cloudflared.js, which supervises
// cloudflared the same way: a globalThis-held child handle (survives Next's
// dev hot-reload), a PID file so a stale child is still discoverable, and a
// buildStatus() that reports what the UI needs.
//
// ⚠️ SINGLETON IS LOAD-BEARING: litestream's docs are explicit that only one
// instance may replicate a given database. Two of them would both hold the
// same replica and interleave LTX files. The globalThis handle plus the PID
// file is what prevents a second start; do not "just spawn it" elsewhere.
//
// ⚠️ WHY retention IS DISABLED: by default litestream DELETES old remote
// files to enforce a retention window. Deleting backups is exactly the failure
// this feature exists to prevent, so the config leaves retention to the
// storage provider's lifecycle rules (an operator decision, visible in the
// cloud console) rather than letting a background process decide.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";
import { DATA_FILE } from "@/lib/db/paths.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { decryptBackupSecret } from "./crypto.js";
import { BACKUP_DIR, CONFIG_FILE, buildConfig, buildEnv } from "./litestreamConfig.js";
import { describeDestination, DESTINATION_TYPES } from "@/shared/constants/backupDestinations.js";
import { getActiveDestination, destinationHasCredentials, getActiveDestinationId } from "./destinations.js";

const PID_FILE = path.join(BACKUP_DIR, "litestream.pid");
const LOG_FILE = path.join(BACKUP_DIR, "litestream.log");

export const LITESTREAM_BIN = String(process.env.LITESTREAM_BIN || "litestream").trim() || "litestream";

if (!globalThis.__springMouseLitestream) {
  globalThis.__springMouseLitestream = {
    child: null,
    startPromise: null,
    startedAt: null,
    // Fingerprint of the destination the current child was started for; see
    // startLitestream. Replaces the old single replicaUrl.
    fingerprint: null,
    lastError: null,
    stderrTail: [],
  };
}
const runtime = globalThis.__springMouseLitestream;

function ensureDir() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The PID file records a fingerprint of the destination alongside the PID. That
// pairing is what lets a later start tell "the same replicator is already
// running" apart from "the destination changed but the old process is still
// writing to the old place" — the latter must be stopped and replaced, not
// adopted. A file from an older build has no fingerprint (or a bare PID); that
// reads as "unknown", which safely forces a replace.
function loadState() {
  try {
    const raw = fs.readFileSync(PID_FILE, "utf8").trim();
    // Tolerate a bare PID in case a file from an older build is present.
    if (/^\d+$/.test(raw)) return { pid: Number.parseInt(raw, 10), fingerprint: null };
    const parsed = JSON.parse(raw);
    const pid = Number.parseInt(parsed?.pid, 10);
    return Number.isInteger(pid) && pid > 0 ? { pid, fingerprint: parsed.fingerprint ?? null } : null;
  } catch {
    return null;
  }
}

function loadPid() {
  return loadState()?.pid ?? null;
}

function savePid(pid, fingerprint = null) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  ensureDir();
  fs.writeFileSync(PID_FILE, JSON.stringify({ pid, fingerprint, startedAt: new Date().toISOString() }), { mode: 0o600 });
}

function clearPid(expectedPid = null) {
  const current = loadPid();
  if (expectedPid !== null && current !== expectedPid) return;
  try {
    fs.unlinkSync(PID_FILE);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function stopPid(pid) {
  if (!pid) return;
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  clearPid(pid);
}

function currentChildIsRunning() {
  const child = runtime.child;
  return Boolean(child?.pid && child.exitCode === null && !child.killed);
}

// Resolve everything the child needs from the settings row. Throws with an
// operator-readable message when backup is misconfigured — the caller surfaces
// that text in the UI rather than a generic failure.
//
// Returns the ACTIVE destination plus its decrypted secret. Which destination
// is active, and how a legacy install maps onto one, is decided in
// destinations.js — this function only decrypts.
export async function resolveActiveDestination(settings = null) {
  const s = settings || (await getSettings());
  if (s.backupEnabled !== true) throw new Error("Backup is disabled");

  const { destination, destinations, legacy } = getActiveDestination(s);
  if (!destination) throw new Error("No backup destination configured");

  const type = destination.type;
  // file and gs need no credentials; sftp may authenticate with a key path
  // alone. Only the types that genuinely require a secret are checked.
  const needsSecret = type !== "file" && type !== "gs"
    && !(type === "sftp" && String(destination.config?.keyPath ?? "").trim());

  let secret = {};
  if (destination.secretEncrypted) {
    secret = JSON.parse(decryptBackupSecret(destination.secretEncrypted));
  } else if (legacy || type === "url") {
    // The pre-refactor shape stored the pair in its own columns.
    const id = s.backupAccessKeyIdEncrypted ? decryptBackupSecret(s.backupAccessKeyIdEncrypted) : "";
    const key = s.backupAccessKeySecretEncrypted ? decryptBackupSecret(s.backupAccessKeySecretEncrypted) : "";
    secret = { accessKeyId: id, accessKeySecret: key };
  }
  if (needsSecret) {
    const required = destinationTypeSecretFields(type);
    const missing = required.filter((k) => !String(secret[k] ?? "").trim());
    if (missing.length) throw new Error("Backup credentials are required for this destination");
  }

  return { destination, destinations, secret, databasePath: DATA_FILE };
}

function destinationTypeSecretFields(type) {
  const spec = DESTINATION_TYPES[type];
  return (spec?.secretFields ?? []).filter((f) => f.required).map((f) => f.key);
}

// A stable identity for "the destination the child is currently replicating
// to". Comparing this instead of just the URL is what makes EDITING the active
// destination (a changed bucket, a rotated key) replace the child, not just
// switching to a different one.
function destinationFingerprint(destination) {
  const payload = JSON.stringify({
    id: destination.id,
    type: destination.type,
    config: destination.config,
    secret: destination.secretEncrypted ?? null,
  });
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function writeConfigIfNeeded(destination) {
  ensureDir();
  const next = buildConfig(destination);
  let current = "";
  try { current = fs.readFileSync(CONFIG_FILE, "utf8"); } catch {}
  if (current !== next) fs.writeFileSync(CONFIG_FILE, next, { mode: 0o600 });
  return CONFIG_FILE;
}

// Start replication. Idempotent: a second call while one is starting or
// running returns the same promise / a no-op, because two replicators must
// never coexist.
export async function startLitestream(settings = null) {
  if (runtime.startPromise) return runtime.startPromise;

  // Resolve the desired destination FIRST: deciding whether a running process
  // may be reused requires knowing what it was started for.
  const { destination, secret } = await resolveActiveDestination(settings);
  const fingerprint = destinationFingerprint({ ...destination, secret });

  if (currentChildIsRunning()) {
    // Our own child. If the destination changed, it is replicating to the wrong
    // place and must be replaced — adopting it would leave the operator's new
    // destination silently ignored.
    const runningFor = runtime.fingerprint;
    if (!runningFor || runningFor === fingerprint) {
      return { started: false, reason: "already running", pid: runtime.child.pid };
    }
    stopLitestream();
  }

  // A previous app process may have left litestream running — a crash, a hard
  // restart, or an exit path that did not stop it. The PID file is what
  // survives that, and two replicators on one replica interleave LTX files,
  // which is the corruption the singleton rule exists to prevent.
  const saved = loadState();
  if (saved && isProcessAlive(saved.pid)) {
    // Same destination: adopt it, so a restart does not spawn a duplicate.
    // A PID file written before fingerprints existed has none: treat it as
    // unknown and replace, which is the safe direction.
    if (saved.fingerprint && saved.fingerprint === fingerprint) {
      runtime.startedAt ??= new Date().toISOString();
      runtime.fingerprint = fingerprint;
      return { started: false, reason: "already running", pid: saved.pid };
    }
    // Different destination (or one recorded before fingerprints existed): the
    // old process is writing to the wrong place, so replace it.
    stopPid(saved.pid);
  } else if (saved) {
    // Stale PID (the process is gone): clear it so it cannot be mistaken for a
    // live replicator later.
    clearPid(saved.pid);
  }

  runtime.startPromise = (async () => {
    const configPath = writeConfigIfNeeded({ ...destination, secret });
    const env = buildEnv({ ...destination, secret });

    const child = spawn(LITESTREAM_BIN, ["replicate", "-config", configPath], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env,
    });
    runtime.child = child;
    runtime.startedAt = new Date().toISOString();
    // Recorded so a later start can tell whether a running process still points
    // at the configured destination.
    runtime.fingerprint = fingerprint;
    runtime.lastError = null;
    runtime.stderrTail = [];
    savePid(child.pid, fingerprint);

    // A missing or non-executable binary emits 'error' instead of 'exit', and an
    // unhandled 'error' on a ChildProcess is re-thrown as an uncaughtException —
    // which takes the whole server down. That is not hypothetical: LITESTREAM_BIN
    // defaults to a bare "litestream" on PATH, so any host without it (a Mac dev
    // box, a slim image) would crash the app on the first enable instead of
    // showing an error. Capture it here and let the readiness check below throw.
    let spawnError = null;
    child.once("error", (error) => {
      spawnError = error;
      if (runtime.child === child) {
        runtime.child = null;
        runtime.fingerprint = null;
      }
      clearPid(child.pid);
    });

    // Keep the last lines of stderr so a failure that happens after start
    // (bad credentials, unreachable bucket) is visible in the UI instead of
    // only in the container log.
    const note = (chunk) => {
      const text = chunk.toString();
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        runtime.stderrTail.push(line);
      }
      if (runtime.stderrTail.length > 40) runtime.stderrTail.splice(0, runtime.stderrTail.length - 40);
    };
    child.stdout?.on("data", note);
    child.stderr?.on("data", note);

    child.once("exit", (code, signal) => {
      const wasCurrent = runtime.child === child;
      if (wasCurrent) {
        runtime.child = null;
        runtime.fingerprint = null;
      }
      clearPid(child.pid);
      if (code !== 0 && code !== null && !runtime.lastError) {
        runtime.lastError = `litestream exited (${signal || code})`;
      }
    });

    // Litestream does not report readiness on a port we can poll. Give it a
    // moment to fail on a bad URL/credential, so an immediate start does not
    // look successful when it is about to exit.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // A failed spawn never sets exitCode, so check spawnError first — otherwise
    // a missing binary would be reported as a successful start.
    if (spawnError) {
      const hint = spawnError.code === "ENOENT"
        ? " — install litestream or set LITESTREAM_BIN to its path"
        : "";
      throw new Error(`cannot run litestream (${LITESTREAM_BIN}): ${spawnError.message}${hint}`);
    }
    if (child.exitCode !== null) {
      const tail = runtime.stderrTail.slice(-3).join(" | ");
      throw new Error(runtime.lastError || tail || "litestream failed to start");
    }
    return { started: true, pid: child.pid };
  })()
    .catch((error) => {
      runtime.lastError = error.message;
      throw error;
    })
    .finally(() => {
      runtime.startPromise = null;
    });

  return runtime.startPromise;
}

export function stopLitestream() {
  const pid = runtime.child?.pid ?? loadPid();
  if (runtime.child) {
    try { runtime.child.kill("SIGTERM"); } catch {}
    runtime.child = null;
  } else if (isProcessAlive(pid)) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  clearPid();
  runtime.startedAt = null;
  runtime.fingerprint = null;
  return { stopped: Boolean(pid) };
}

export async function getBackupStatus(settings = null) {
  const s = settings || (await getSettings());
  const pid = runtime.child?.pid ?? loadPid();
  const running = currentChildIsRunning() || isProcessAlive(pid);
  const { destination, destinations } = getActiveDestination(s);
  // The URL shown in the UI is DERIVED and secret-free: an sftp/webdav address
  // is rendered without its password, so a display string can never leak one.
  let replicaUrl = "";
  let urlError = null;
  try { replicaUrl = describeDestination(destination); } catch (e) { urlError = e.message; }
  return {
    enabled: s.backupEnabled === true,
    running,
    pid: running ? pid : null,
    replicaUrl,
    replicaUrlError: urlError,
    activeDestinationId: getActiveDestinationId(s, destinations),
    destinationCount: destinations.length,
    hasCredentials: destinationHasCredentials(destination, s),
    startedAt: runtime.startedAt,
    lastError: runtime.lastError,
    recentLog: runtime.stderrTail.slice(-10),
    configPath: CONFIG_FILE,
  };
}

// Exposed for the restore path, which needs the same resolved config without
// going through the child-process lifecycle.
export { CONFIG_FILE, BACKUP_DIR, LOG_FILE, writeConfigIfNeeded };
