#!/usr/bin/env node
/**
 * 强制重启开发服务器：先清掉占用 8007 的进程（含 npm 孤儿化的 next 子进程），
 * 再以当前进程为会话首进程启动 next dev——Ctrl+C 或进程退出时子进程一并结束，
 * 不会再留下占端口的孤儿进程。
 */
import { spawn, execSync } from "child_process";

const PORT = 8007;

// 1. 清端口：杀掉所有监听者（自己的父进程无关，只杀监听该端口的）
try {
  const pids = execSync(`lsof -ti:${PORT}`, { encoding: "utf8" }).trim();
  if (pids) {
    for (const pid of pids.split("\n").filter(Boolean)) {
      try {
        process.kill(Number(pid), "SIGKILL");
        console.log(`已结束占用 ${PORT} 的进程 ${pid}`);
      } catch { /* 已退出 */ }
    }
  }
} catch { /* 端口空闲 */ }

// 2. 直接以本进程为父启动 next dev（绕过 npm 包装，进程树干净）
const child = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "dev", "--port", String(PORT)],
  { stdio: "inherit" }
);

// 3. 信号转发：Ctrl+C / 终止时连带结束 next，不留孤儿
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    child.kill(sig);
  });
}
child.on("exit", (code) => process.exit(code ?? 0));
