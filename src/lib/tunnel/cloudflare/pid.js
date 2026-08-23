import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";

const TUNNEL_DIR = path.join(DATA_DIR, "tunnel");
const PID_FILE = path.join(TUNNEL_DIR, "cloudflared.pid");

function ensureTunnelDir() {
  fs.mkdirSync(TUNNEL_DIR, { recursive: true });
}

export function loadPid() {
  try {
    const pid = Number.parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function savePid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  ensureTunnelDir();
  fs.writeFileSync(PID_FILE, String(pid), { mode: 0o600 });
}

// Do not delete a newer child process's PID file when an older child exits.
export function clearPid(expectedPid = null) {
  const currentPid = loadPid();
  if (expectedPid !== null && currentPid !== expectedPid) return;
  try {
    fs.unlinkSync(PID_FILE);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
