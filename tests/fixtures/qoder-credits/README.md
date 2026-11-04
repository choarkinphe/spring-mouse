# Qoder / WorkBuddy credit billing preview

Launch `qoder-credits-fixture` from `.claude/launch.json` (port 8087). The unified
entry point seeds four synthetic OAuth accounts into a new temporary DATA_DIR and
HOME, suppresses host background jobs, blocks real upstream fetches, starts Next,
and waits for `/api/health`. It stops only its own children on exit.

Open `/dashboard/providers?channel=qoder-cn`. Use **同步模型** or **同步积分倍率** to
exercise the actual official-discovery and persistence routes. Expected Qoder
cards include Qwen3.8-Flash 免费 with crossed-out 0.1×, Fast 0.8×, Ultimate 2×,
DeepSeek-Flash 0.1×, and native IDs in the code row. Auto is not a listed model.
Repeat for Qoder, WorkBuddy and WorkBuddy AI; WorkBuddy reads `credits: x…`.

Qoder CN's **立即签到** claims a synthetic 50-credit campaign. A second click is
idempotent. The auto-check-in switch persists but the scheduler is intentionally
disabled in the fixture. Qoder international returns an actionable `own_app`
message without an installed official runtime identity. No real tokens or claims
are used; fixture HOME also isolates official runtime discovery.
