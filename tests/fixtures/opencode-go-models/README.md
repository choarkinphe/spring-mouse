# OpenCode Go model discovery fixture

Run the `opencode-go-models-fixture` Claude Preview configuration. The unified `start.sh` starts a local catalog mock (9057), seeds a fresh temporary SQLite database and HOME, starts the dashboard (8057), and waits for both health checks. It refuses occupied ports and cleans up only its child processes.

The shared smoke preload suppresses background services and blocks external fetch. This fixture redirects only `https://opencode.ai/inference/go/v1/models` to the local mock; no real subscription key is used. This guard is not an operating-system network sandbox. Browser-side public assets can still load normally.

Seeded rows:

- A Go account with a fake key.
- Old synchronized `deepseek-v4-flash` (official) and `glm-5.1` (static).
- A manually added `manual-keep`.

Open `http://localhost:8057/dashboard/providers?channel=opencode-go` and synchronize. The mock returns `kimi-k3`, `deepseek-v4.1-flash`, and `minimax-m3`. Both old synchronized rows must be removed; the manual row must survive. No other static seed should appear. The UI must identify the list as a public directory, not proof of subscription access.

With the fixture running, verify real API behavior:

```bash
node tests/fixtures/opencode-go-models/verify.mjs
```

The verifier covers discovery, known-model protocol metadata, synchronization, stale removal, manual preservation, failed/malformed upstream responses, failed-sync protection, valid empty-directory cleanup, and absence of Authorization on the public request. It ends with only the manual row in storage and the mock restored to success mode. Reload the page, open Add Model, and search `kimi` to verify candidates; then synchronize again.

The mock's loopback-only `POST /state` accepts `{ "mode": "ok" | "error" | "malformed" | "empty" }`. Error mode returns 503; the UI must show a failure, keep existing models, and not submit a model-sync request. `/requests` records whether Authorization was sent, never its value.
