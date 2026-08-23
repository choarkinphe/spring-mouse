# Spring Mouse Setup CLI

把本机的 AI 编码工具（Claude Code / Codex / Cline / GitHub Copilot / Kilo / OpenCode）一键配置为走 Spring Mouse 端点。

**独立客户端项目**：零依赖主仓库代码（仅依赖 `confbox` 处理 TOML），整个目录可单独复制为独立仓库。服务端无论部署在本机、远程服务器还是 Docker，都可用本客户端配置本机工具。

## 用法

```bash
npm install
node cli.js list                                              # 列出工具 + 接入状态
node cli.js status [tool]                                     # 查看接入状态
node cli.js apply claude --endpoint http://localhost:8007 --key sk-xxx
node cli.js apply codex --endpoint ... --key ... --model glm-4.7 [--subagent-model ...]
node cli.js apply cline  --endpoint ... --key ... --model glm-4.7
node cli.js apply copilot --endpoint ... --models glm-4.7,gpt-5-mini
node cli.js apply kilo    --endpoint ... --key ... --model glm-4.7
node cli.js apply opencode --endpoint ... --key ... --models a,b [--subagent-model ...]
node cli.js reset claude                                      # 移除接入（兼容清除历史 spring-mouse/9router 标识）
```

## 架构

```
cli.js              入口：参数解析 + 命令分发（零依赖）
lib/commands.js     list / status / apply / reset 命令实现
lib/util.js         JSON读写、端点规范化（±/v1）、旧标识兼容清理
lib/tools/*.js      每工具一模块：status() / apply(params) / reset() 三函数
```

新增工具 = 在 `lib/tools/` 加一个实现三个函数的模块 + 在 `commands.js` 的 `TOOLS` 注册。移植自主仓库已删除的 `dashboard/cli-tools` 页面逻辑（见下）。

## 已知边界

- 移植了 6 个主力工具；主仓库原有的 droid/devin/hermes/jcode/grok-build/deepseek-tui/openclaw/cowork(MCP注入)/antigravity(MITM) 尚未移植，按需在 `lib/tools/` 补齐即可
- 写入的新配置统一使用 `spring-mouse` 标识；`reset` 会同时清除历史 `9router` 标识的旧配置

## GUI 计划（需求记录，暂不实施）

目标：为setup能力提供图形界面，打包为 Windows / macOS 桌面应用。

候选方案（决策待定）：

| 方案 | 逻辑复用 | 体积 | 备注 |
|---|---|---|---|
| Electron | 直接 import lib/tools，100%复用 | 100-200MB | 改动最小，electron-builder 出双平台包 |
| Flutter Desktop + sidecar | 捆绑本CLI为sidecar二进制，Dart调进程 | 30-50MB | 保持单一事实源；用户熟悉Flutter |
| Flutter Desktop + Dart重写 | 重写 lib/tools（约500行文件操作） | 30-50MB | 彻底去Node依赖，双份逻辑需同步维护 |
| 内置 `ui` 子命令（浏览器） | 100%复用 | 无需打包 | 非桌面App形态 |

硬性需求：
1. 跨平台（Windows + macOS）
2. 能读写本机各工具配置文件（JSON/TOML），行为与CLI一致
3. GUI 操作与 CLI 命令一一对应（list/status/apply/reset）
4. 不阻塞：CLI 永远保留（脚本化/远程场景）
