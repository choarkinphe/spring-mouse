# Provider quota units fixture

Uses a fresh temporary DATA_DIR/HOME and fake connections for OpenCode Go, Codex, CodeBuddy CN, Qoder, and DeepSeek. The preload serves quota snapshots locally and blocks other upstream fetches. No real credentials or paid inference are used.

Launch with Claude Preview using `provider-quota-units-fixture` (port 8127 in the session configuration), then:

```bash
SMOKE_PORT=8127 node tests/fixtures/provider-quotas/verify.mjs
```

Browse `/dashboard/providers` and select channels:

- Codex: primary window duration 604800 seconds, `周额度` and `余量 100%`; no secondary window. It keeps the stable `session` key internally.
- OpenCode Go: five-hour / weekly / monthly remaining percentages of 82 / 53 / 37, with upstream reset times.
- CodeBuddy CN: `余量 224.64 积分` for the monthly package and `余量 0 积分` for the exhausted bonus package.
- Qoder: remaining credit amounts, not used/total pairs, percent or requests.
- DeepSeek: `余额 ¥42.50`.

Used/total is available in the amount's hover/focus detail rather than primary text.

On `/dashboard`, quota summary values are **remaining**: Go monthly 37%, Codex weekly 100%, CodeBuddy monthly credits, Qoder organization credits, and DeepSeek ¥42.50. The summary picks the lowest-remaining window per account, so do not interpret it as an aggregate.

The launcher refuses an occupied port and cleans up only its own child processes. It uses Turbopack and needs a local node_modules tree (Turbopack does not accept dependencies symlinked outside its project root).
