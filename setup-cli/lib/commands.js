import * as claude from "./tools/claude.js";
import * as codex from "./tools/codex.js";
import * as cline from "./tools/cline.js";
import * as copilot from "./tools/copilot.js";
import * as kilo from "./tools/kilo.js";
import * as opencode from "./tools/opencode.js";

export const TOOLS = { claude, codex, cline, copilot, kilo, opencode };

export function usage() {
  console.log(`Spring Mouse Setup CLI — 把本机 AI 编码工具接入 Spring Mouse 端点

用法:
  spring-mouse-setup list                                  列出支持的工具
  spring-mouse-setup status [tool]                         查看接入状态（全部或单个）
  spring-mouse-setup apply <tool> --endpoint URL --key KEY [选项]
  spring-mouse-setup reset <tool>                          移除某工具的接入配置

apply 选项:
  --endpoint URL        Spring Mouse 地址（如 http://localhost:8007）
  --key KEY             端点 API Key（copilot 可省略）
  --model ID            默认模型（cline/kilo/codex 必填）
  --models a,b,c        模型列表（copilot/opencode）
  --subagent-model ID   子代理模型（codex/opencode）
  --opus/--sonnet/--haiku ID    Claude Code 的三档模型别名（可选）

示例:
  spring-mouse-setup apply claude --endpoint http://localhost:8007 --key sk-xxx
  spring-mouse-setup apply codex --endpoint http://localhost:8007 --key sk-xxx --model glm-4.7
  spring-mouse-setup status`);
}

export async function runList() {
  console.log("支持的工具：\n");
  for (const mod of Object.values(TOOLS)) {
    const s = await mod.status();
    console.log(`  ${s.tool.padEnd(10)} ${s.name}${s.configured ? "  ● 已接入" : ""}`);
  }
  console.log("\n用 spring-mouse-setup apply <tool> ... 接入，reset <tool> 移除。");
}

export async function runStatus(toolId) {
  if (toolId) {
    const mod = TOOLS[toolId];
    if (!mod) throw new Error(`未知工具: ${toolId}（用 list 查看）`);
    const s = await mod.status();
    printStatus(s);
    return;
  }
  for (const mod of Object.values(TOOLS)) {
    printStatus(await mod.status());
  }
}

function printStatus(s) {
  console.log(`${s.name}  ${s.configured ? "● 已接入" : "○ 未接入"}`);
  console.log(`  配置文件: ${s.settingsFile}`);
  if (s.endpoint) console.log(`  端点: ${s.endpoint}`);
  console.log();
}

export async function runApply(toolId, flags) {
  const mod = TOOLS[toolId];
  if (!mod) throw new Error(`未知工具: ${toolId}（用 list 查看）`);

  const params = {
    endpoint: flags.endpoint,
    key: flags.key,
    model: flags.model,
    models: flags.models ? String(flags.models).split(",").map((m) => m.trim()).filter(Boolean) : undefined,
    subagentModel: flags["subagent-model"],
    opusModel: flags.opus,
    sonnetModel: flags.sonnet,
    haikuModel: flags.haiku,
  };

  const result = await mod.apply(params);
  console.log(`✓ ${toolId} 配置已写入`);
  console.log(`  文件: ${result.file}`);
  if (result.authFile) console.log(`  认证: ${result.authFile}`);
  if (result.vscodeFile) console.log(`  VS Code: ${result.vscodeFile}`);
  if (result.models) console.log(`  模型: ${result.models.join(", ")}`);
  console.log(`\n重启对应工具后生效。`);
}

export async function runReset(toolId) {
  const mod = TOOLS[toolId];
  if (!mod) throw new Error(`未知工具: ${toolId}（用 list 查看）`);
  const result = await mod.reset();
  console.log(`✓ ${toolId} 接入配置已移除 (${result.file})`);
}
