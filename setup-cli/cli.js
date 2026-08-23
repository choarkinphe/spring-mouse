#!/usr/bin/env node
/**
 * Spring Mouse Setup CLI
 * 把本机的 AI 编码工具（Claude Code / Codex / Cline / Copilot / Kilo / OpenCode）
 * 一键配置为走 Spring Mouse 端点。独立于服务端运行，可指向任意端点（本地/远程/共享）。
 *
 * 用法：
 *   spring-mouse-setup list
 *   spring-mouse-setup status [tool]
 *   spring-mouse-setup apply <tool> --endpoint http://localhost:8007 --key sk-xxx [--model glm-4.7]
 *   spring-mouse-setup reset <tool>
 */

import { runList, runStatus, runApply, runReset, usage } from "./lib/commands.js";

const [cmd, ...rest] = process.argv.slice(2);

// 极简参数解析：--key value 与 --flag
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

try {
  const positional = rest.filter((a) => !a.startsWith("--"));
  const flags = parseArgs(rest);
  switch (cmd) {
    case "list":
      await runList();
      break;
    case "status":
      await runStatus(positional[0]);
      break;
    case "apply":
      await runApply(positional[0], flags);
      break;
    case "reset":
      await runReset(positional[0]);
      break;
    default:
      usage();
      process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
}
