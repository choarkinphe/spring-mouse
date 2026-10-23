# OpenCode Go model discovery fixture

Run the `opencode-go-models-fixture` Claude Preview configuration. The unified `start.sh` starts a local catalog mock (9057), seeds a fresh temporary SQLite database and HOME, starts the dashboard (8057), and waits for both health checks. It refuses occupied ports and cleans up only its child processes.

The shared smoke preload suppresses background services and blocks external fetch. This fixture redirects the public Go catalog and Go Chat Completions routes to the local mock; no real subscription key is used. The chat mock requires session and client identity headers and supports JSON and SSE. This guard is not an operating-system network sandbox. Browser-side public assets can still load normally.

Seeded rows:

- A Go account with a fake key.
- Old synchronized `deepseek-v4-flash` (official) and `glm-5.1` (static).
- A manually added `manual-keep`.

Open `http://localhost:8057/dashboard/providers?channel=opencode-go` and synchronize. The mock returns `kimi-k3`, `deepseek-v4.1-flash`, and `minimax-m3`. Both old synchronized rows must be removed; the manual row must survive. No other static seed should appear. The UI must identify the list as a public directory, not proof of subscription access.

With the fixture running, verify real API behavior:

```bash
node tests/fixtures/opencode-go-models/verify.mjs
```

The verifier covers discovery, known-model protocol metadata, server-side re-discovery during synchronization, the atomic official snapshot, stale removal, manual preservation, failed/malformed upstream responses, empty-directory protection (HTTP 409, no changes), and absence of Authorization on the public request. It leaves the last valid official rows and manual row intact, with the mock restored to success mode.

The mock's loopback-only `POST /state` accepts `{ "mode": "ok" | "error" | "malformed" | "empty" | "reject" }`. Error mode returns 503 for catalog requests; reject mode returns 400 for chat requests. `/requests` records whether Authorization was sent, never its value; chat entries also include the synthetic session, User-Agent and model.

For isolated routing verification, start the same unified launcher with `SMOKE_PORT=8087`, `MOCK_PORT=9087` and a separate `NEXT_DIST_DIR`, then run:

```bash
node tests/fixtures/opencode-go-models/verify-routing.mjs
```

The routing verifier checks health, account/model probes, independent test sessions, stable user sessions, OpenAI/Claude JSON and SSE translation, and rejection handling. It requires the seeded fixture account and healthy loopback mock. Real callers must supply stable session information; the gateway does not create fake conversations from accounts or request IDs.
