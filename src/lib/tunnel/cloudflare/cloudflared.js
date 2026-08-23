import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";
import { clearPid, loadPid, savePid } from "./pid.js";

const TUNNEL_DIR = path.join(DATA_DIR, "tunnel");
const STATE_FILE = path.join(TUNNEL_DIR, "cloudflare.json");

if (!globalThis.__springMouseCloudflareTunnel) {
  globalThis.__springMouseCloudflareTunnel = { child: null, startPromise: null };
}
const runtime = globalThis.__springMouseCloudflareTunnel;

function ensureTunnelDir() {
  fs.mkdirSync(TUNNEL_DIR, { recursive: true });
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeState(next) {
  ensureTunnelDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
}

function removeState() {
  try {
    fs.unlinkSync(STATE_FILE);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
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

function normalizePublicUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error("Public hostname must be a valid URL or hostname");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Public hostname must use http:// or https://");
  }
  return parsed.toString().replace(/\/$/, "");
}

function currentChildIsRunning() {
  const child = runtime.child;
  return Boolean(child?.pid && child.exitCode === null && !child.killed);
}

function buildStatus(settings = {}) {
  const state = readState();
  const childRunning = currentChildIsRunning();
  const savedPid = loadPid();
  const running = childRunning || isProcessAlive(savedPid);
  const configuredPublicUrl = normalizeStoredPublicUrl(settings.cloudflareTunnelPublicUrl);
  const publicUrl = state.publicUrl || configuredPublicUrl || "";

  return {
    enabled: running,
    running,
    provider: "cloudflare",
    publicUrl,
    tunnelUrl: publicUrl,
    shortId: publicUrl ? publicUrl.replace(/^https?:\/\//, "") : "",
    configuredPublicUrl,
    pid: running ? (runtime.child?.pid || savedPid || null) : null,
  };
}

function normalizeStoredPublicUrl(value) {
  try {
    return normalizePublicUrl(value);
  } catch {
    return "";
  }
}

export function getCloudflareTunnelStatus(settings = {}) {
  const status = buildStatus(settings);
  if (!status.running && loadPid()) clearPid();
  return { ...status, enabled: status.running };
}

export async function startCloudflareTunnel(settings = {}) {
  if (runtime.startPromise) return runtime.startPromise;
  if (currentChildIsRunning()) return getCloudflareTunnelStatus(settings);

  runtime.startPromise = new Promise((resolve, reject) => {
    const publicUrl = normalizeStoredPublicUrl(settings.cloudflareTunnelPublicUrl);
    const executable = String(process.env.CLOUDFLARED_BIN || "cloudflared").trim() || "cloudflared";
    const token = String(settings.cloudflareTunnelToken || "").trim();

    if (!token) {
      reject(new Error("请先填写 Cloudflare Tunnel Token"));
      return;
    }
    if (!publicUrl) {
      reject(new Error("请先填写 Cloudflare 公网访问地址"));
      return;
    }

    const args = ["--no-autoupdate", "tunnel", "run", "--token", token];
    let settled = false;
    let output = "";
    let cloudflaredProcess;
    let timeout = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      runtime.startPromise = null;
      fn(value);
    };

    const fail = (error) => {
      if (cloudflaredProcess?.pid) clearPid(cloudflaredProcess.pid);
      if (runtime.child === cloudflaredProcess) runtime.child = null;
      removeState();
      const detail = String(error?.message || error || "Failed to start cloudflared");
      finish(reject, new Error(detail));
    };

    try {
      cloudflaredProcess = spawn(executable, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      fail(error);
      return;
    }

    runtime.child = cloudflaredProcess;
    if (cloudflaredProcess.pid) savePid(cloudflaredProcess.pid);

    const consumeOutput = (chunk) => {
      output = `${output}${String(chunk)}`.slice(-6000);
    };

    cloudflaredProcess.stdout?.on("data", consumeOutput);
    cloudflaredProcess.stderr?.on("data", consumeOutput);
    cloudflaredProcess.once("error", (error) => {
      const message = error?.code === "ENOENT"
        ? `cloudflared executable not found (${executable}). Install cloudflared or set CLOUDFLARED_BIN.`
        : error.message;
      fail(new Error(message));
    });
    cloudflaredProcess.once("exit", (code, signal) => {
      clearPid(cloudflaredProcess.pid);
      if (runtime.child === cloudflaredProcess) runtime.child = null;
      if (!settled) {
        const suffix = output.trim() ? `: ${output.trim().split("\n").slice(-4).join(" ")}` : "";
        fail(new Error(`cloudflared exited (${signal || code || "unknown"})${suffix}`));
      }
    });

    // A named tunnel has no generated URL to wait for. A short grace period
    // catches immediate token/binary failures before reporting success.
    timeout = setTimeout(() => {
      if (currentChildIsRunning()) {
        writeState({ publicUrl, pid: cloudflaredProcess.pid, startedAt: new Date().toISOString() });
        finish(resolve, getCloudflareTunnelStatus(settings));
        return;
      }
      fail(new Error(`cloudflared failed to stay running. ${output.trim().slice(-500)}`.trim()));
    }, 2_000);
  });

  return runtime.startPromise;
}

export async function stopCloudflareTunnel() {
  const child = runtime.child;
  const pid = child?.pid || loadPid();

  if (child && currentChildIsRunning()) {
    child.kill("SIGTERM");
  } else if (pid && isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // A process can exit after liveness is checked.
    }
  }

  if (child?.pid) clearPid(child.pid);
  else clearPid();
  runtime.child = null;
  runtime.startPromise = null;
  removeState();
  return { enabled: false, running: false, provider: "cloudflare", publicUrl: "", tunnelUrl: "", shortId: "" };
}
