import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const dataDir = process.env.DATA_DIR || "/app/data";
const appRoot = process.env.SPRING_MOUSE_APP_ROOT || "/app";
const redisDir = path.join(dataDir, "redis");
const redisPort = process.env.SPRING_MOUSE_REDIS_PORT || "6379";
const redisUrl = process.env.SPRING_MOUSE_REDIS_URL || `redis://127.0.0.1:${redisPort}`;
const children = new Map();
let stopping = false;

fs.mkdirSync(redisDir, { recursive: true });
process.env.SPRING_MOUSE_REDIS_URL = redisUrl;
process.env.SPRING_MOUSE_REDIS_REQUIRED = "true";

function start(name, command, args, options = {}) {
  const child = spawn(command, args, { stdio: "inherit", env: process.env, ...options });
  children.set(name, child);
  child.once("exit", (code, signal) => {
    children.delete(name);
    if (!stopping) {
      console.error(`[Supervisor] ${name} exited unexpectedly (${signal || code})`);
      shutdown(code || 1);
    }
  });
  return child;
}

async function waitForRedis() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const probe = spawn("redis-cli", ["-h", "127.0.0.1", "-p", redisPort, "PING"], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    probe.stdout.on("data", (chunk) => { output += chunk; });
    const ok = await new Promise((resolve) => probe.once("exit", (code) => resolve(code === 0 && output.trim() === "PONG")));
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("embedded Redis did not become ready");
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children.values()) {
    try { child.kill("SIGTERM"); } catch {}
  }
  const timer = setTimeout(() => {
    for (const child of children.values()) {
      try { child.kill("SIGKILL"); } catch {}
    }
    process.exit(code);
  }, 10000);
  timer.unref();
  const poll = setInterval(() => {
    if (children.size === 0) {
      clearInterval(poll);
      clearTimeout(timer);
      process.exit(code);
    }
  }, 50);
  poll.unref();
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => shutdown(0));

const redisArgs = [
  "--bind", "127.0.0.1",
  "--port", redisPort,
  "--protected-mode", "yes",
  "--dir", redisDir,
  "--appendonly", "yes",
  "--appendfsync", "everysec",
  "--save", "900 1 300 10 60 10000",
  "--maxmemory-policy", "noeviction",
];

start("redis", "redis-server", redisArgs);
await waitForRedis();
start("usage-writer", process.execPath, [path.join(appRoot, "runtime/usage-writer.mjs")]);
start("spring-mouse", process.execPath, [path.join(appRoot, "custom-server.js"), ...process.argv.slice(2)]);
