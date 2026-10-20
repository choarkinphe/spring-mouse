# Provider quota units fixture

Uses a fresh temporary DATA_DIR/HOME and fake connections for OpenCode Go, Codex, Qoder, and DeepSeek. The preload serves quota snapshots locally and blocks other upstream fetches. No real credentials or paid inference are used.

Launch with Claude Preview using `provider-quota-units-fixture` (port 8127 in the session configuration), then:

```bash
SMOKE_PORT=8127 node tests/fixtures/provider-quotas/verify.mjs
```

Browse `/dashboard/providers` and select channels:

- Codex: `已用 27% / 100%`, weekly `已用 61% / 100%`.
- OpenCode Go: five-hour / weekly / monthly used percentages of 18 / 47 / 63, with upstream reset times.
- Qoder: count quotas labelled `credits`, not percent or requests.
- DeepSeek: `¥42.50` account balance.

On `/dashboard`, quota summary values are **remaining**: Go monthly 37%, Codex weekly 39%, Qoder organization 1,750 credits, and DeepSeek ¥42.50. The summary picks the lowest-remaining window per account, so do not interpret it as an aggregate.

The launcher refuses an occupied port and cleans up only its own child processes. It uses Turbopack and needs a local node_modules tree (Turbopack does not accept dependencies symlinked outside its project root).
