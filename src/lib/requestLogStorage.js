import fs from "node:fs/promises";
import path from "node:path";
import { getSettings } from "@/lib/localDb";

const REQUEST_LOGS_DIR = path.resolve(process.cwd(), "logs");
const ACTIVE_MARKER_FILE = ".active.json";
const ACTIVE_MARKER_MAX_AGE_MS = 5 * 60 * 1000;
const MAX_PREVIEW_BYTES = 256 * 1024;
const SENSITIVE_FIELD = /(authorization|cookie|x-api-key|api[-_]?key|token|secret|password)/i;
const PROCESS_STARTED_AT = typeof process !== "undefined" && process.uptime
  ? Math.round(Date.now() - process.uptime() * 1000)
  : Date.now();

function asIsoDate(value) {
  return value ? new Date(value).toISOString() : null;
}

function assertSegment(value, label) {
  if (typeof value !== "string" || !value || value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function resolveInside(base, segment, label) {
  const target = path.resolve(base, assertSegment(segment, label));
  if (path.dirname(target) !== base) throw new Error(`Invalid ${label}`);
  return target;
}

async function safeReadDir(directory) {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function getSessionActivity(sessionPath) {
  const markerPath = path.join(sessionPath, ACTIVE_MARKER_FILE);
  try {
    const [markerStat, markerText] = await Promise.all([
      fs.stat(markerPath),
      fs.readFile(markerPath, "utf8"),
    ]);
    const marker = JSON.parse(markerText);
    const sameProcess = marker.pid === process.pid
      && Math.abs(Number(marker.processStartedAt) - PROCESS_STARTED_AT) < 5_000;
    const recentlyTouched = Date.now() - markerStat.mtimeMs < ACTIVE_MARKER_MAX_AGE_MS;
    return {
      active: sameProcess && recentlyTouched,
      markerPath,
    };
  } catch {
    return { active: false, markerPath };
  }
}

async function directoryStats(directory) {
  let totalBytes = 0;
  let totalFiles = 0;
  let totalDirectories = 0;
  const entries = await fs.readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isSymbolicLink() || entry.name === ACTIVE_MARKER_FILE) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      totalDirectories += 1;
      const nested = await directoryStats(entryPath);
      totalBytes += nested.totalBytes;
      totalFiles += nested.totalFiles;
      totalDirectories += nested.totalDirectories;
    } else if (entry.isFile()) {
      totalFiles += 1;
      totalBytes += (await fs.stat(entryPath)).size;
    }
  }

  return { totalBytes, totalFiles, totalDirectories };
}

async function removeSessionIfIdle(sessionPath, sessionName) {
  const activity = await getSessionActivity(sessionPath);
  if (activity.active) return { removed: false, active: true, session: sessionName };
  await fs.rm(sessionPath, { recursive: true, force: true });
  return { removed: true, active: false, session: sessionName };
}

export async function isRequestFileLoggingEnabled() {
  const settings = await getSettings();
  return settings.enableRequestLogFileDumps === true;
}

export async function listRequestLogSessions() {
  const entries = await safeReadDir(REQUEST_LOGS_DIR);
  const sessions = [];
  const rootFiles = [];

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const entryPath = path.join(REQUEST_LOGS_DIR, entry.name);
    const stat = await fs.stat(entryPath);
    if (entry.isDirectory()) {
      const [stats, activity] = await Promise.all([
        directoryStats(entryPath),
        getSessionActivity(entryPath),
      ]);
      sessions.push({
        name: entry.name,
        modifiedAt: asIsoDate(stat.mtimeMs),
        bytes: stats.totalBytes,
        files: stats.totalFiles,
        active: activity.active,
      });
    } else if (entry.isFile()) {
      rootFiles.push({ name: entry.name, bytes: stat.size, modifiedAt: asIsoDate(stat.mtimeMs) });
    }
  }

  sessions.sort((a, b) => Number(b.active) - Number(a.active) || Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
  rootFiles.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
  const storage = await directoryStats(REQUEST_LOGS_DIR).catch((error) => {
    if (error?.code === "ENOENT") return { totalBytes: 0, totalFiles: 0, totalDirectories: 0 };
    throw error;
  });

  return {
    enabled: await isRequestFileLoggingEnabled(),
    storage: {
      bytes: storage.totalBytes,
      files: storage.totalFiles,
      sessions: sessions.length,
      activeSessions: sessions.filter((session) => session.active).length,
    },
    sessions,
    rootFiles,
  };
}

export async function getRequestLogSession(session) {
  const sessionPath = resolveInside(REQUEST_LOGS_DIR, session, "session");
  const stat = await fs.lstat(sessionPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Log session not found");

  const files = [];
  for (const entry of await safeReadDir(sessionPath)) {
    if (!entry.isFile() || entry.isSymbolicLink() || entry.name === ACTIVE_MARKER_FILE) continue;
    const fileStat = await fs.stat(path.join(sessionPath, entry.name));
    files.push({ name: entry.name, bytes: fileStat.size, modifiedAt: asIsoDate(fileStat.mtimeMs) });
  }
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const activity = await getSessionActivity(sessionPath);

  return { name: session, modifiedAt: asIsoDate(stat.mtimeMs), active: activity.active, files };
}

function redactLogValue(value, key = "") {
  if (SENSITIVE_FIELD.test(key)) return "***";
  if (Array.isArray(value)) return value.map((item) => redactLogValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redactLogValue(childValue, childKey)]));
  }
  return value;
}

function redactLogContent(content) {
  try {
    return JSON.stringify(redactLogValue(JSON.parse(content)), null, 2);
  } catch {
    return content.replace(
      /((?:authorization|cookie|x-api-key|api[-_]?key|token|secret|password)\s*[:=]\s*)[^\r\n]*/gi,
      "$1***",
    );
  }
}

export async function readRequestLogFile(session, file) {
  if (file === ACTIVE_MARKER_FILE) throw new Error("Invalid file");
  const sessionPath = resolveInside(REQUEST_LOGS_DIR, session, "session");
  const sessionStat = await fs.lstat(sessionPath);
  if (!sessionStat.isDirectory() || sessionStat.isSymbolicLink()) throw new Error("Log session not found");

  const filePath = resolveInside(sessionPath, file, "file");
  const fileStat = await fs.lstat(filePath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error("Log file not found");

  const handle = await fs.open(filePath, "r");
  try {
    const bytesToRead = Math.min(fileStat.size, MAX_PREVIEW_BYTES);
    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, 0);
    return {
      session,
      name: file,
      bytes: fileStat.size,
      truncated: fileStat.size > MAX_PREVIEW_BYTES,
      content: redactLogContent(buffer.toString("utf8")),
    };
  } finally {
    await handle.close();
  }
}

export async function clearRequestLogFiles(session = null) {
  if (session) {
    const sessionPath = resolveInside(REQUEST_LOGS_DIR, session, "session");
    const stat = await fs.lstat(sessionPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Log session not found");
    const result = await removeSessionIfIdle(sessionPath, session);
    return {
      removedSessions: result.removed ? 1 : 0,
      skippedActiveSessions: result.active ? [session] : [],
    };
  }

  const entries = await safeReadDir(REQUEST_LOGS_DIR);
  let removedSessions = 0;
  let removedRootFiles = 0;
  const skippedActiveSessions = [];

  // Delete sequentially to avoid flooding the filesystem and starving live requests.
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const entryPath = path.join(REQUEST_LOGS_DIR, entry.name);
    if (entry.isDirectory()) {
      const result = await removeSessionIfIdle(entryPath, entry.name);
      if (result.removed) removedSessions += 1;
      else if (result.active) skippedActiveSessions.push(entry.name);
    } else if (entry.isFile()) {
      await fs.rm(entryPath, { force: true });
      removedRootFiles += 1;
    }
  }

  return { removedSessions, removedRootFiles, skippedActiveSessions };
}
