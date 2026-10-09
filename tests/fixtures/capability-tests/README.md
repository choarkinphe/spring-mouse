# Model capability fixture

The unified `start.sh` runs the local mock upstream and gateway in dependency order, checks readiness and cleans up only its child processes. Both ports must be free; it never kills an unrelated process. Claude Preview reuses an already running launch configuration.

- Gateway: port 8027, `/dashboard/providers`
- Mock upstream: port 9027
- SQLite / HOME: fresh `/tmp/sm-capability.*/` (never the user's data)
- Provider: `openai-compatible-chat-capability-fixture`, prefix `能力实验`
- Models: `probe-model`, `slow-model`
- Accounts: 文本账号 (rejects images), 多模态账号 (reads generated PNG colors)

Run via Claude Preview configuration `capability-tests-fixture` (local `.claude/launch.json`), or:

```bash
bash tests/fixtures/capability-tests/start.sh
```

Open channel 模型管理 → probe-model 更多操作 → 能力测试. Quick testing checks text, tools, images, PDF and 4K target context. Compare both accounts: only the multimodal account succeeds on images, even though the original catalog says vision:false. Ordinary image requests then skip the text account. Deep context testing receives an explicit 12000-token context limit from the mock. `slow-model` waits 15 seconds for cancel verification.

The server-side preload blocks non-loopback fetch and suppresses host background services. This is not an operating-system network sandbox; the existing dashboard may load public fonts or analytics in the browser. No production credentials are seeded.
