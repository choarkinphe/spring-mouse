# Qoder / WorkBuddy credit billing preview

Launch `qoder-credits-fixture` from `.claude/launch.json` (port 8087). The unified
entry point seeds four synthetic OAuth accounts into a new temporary DATA_DIR and
HOME, suppresses host background jobs, blocks real upstream fetches, starts Next,
and waits for `/api/health`. It stops only its own children on exit.

Open `/dashboard/providers?channel=qoder` to verify the international dedicated-only
quota: Personal has 0 credits, while `SOTA 专属积分 · act-20261112-658` has 2,000
credits, its own expiry, and the upstream Sonus-only explanation. Refreshing the
quota keeps both rows. Qoder CN retains the 300 plan + 100 add-on credit fixture.

Open `/dashboard/providers?channel=qoder-cn`. Use **同步模型** or **同步积分倍率** to
exercise the actual official-discovery and persistence routes. Expected Qoder
cards include Qwen3.8-Flash 免费 with crossed-out 0.1×, Fast 0.8×, Ultimate 2×,
DeepSeek-Flash 0.1×, and native IDs in the code row. Auto is not a listed model.
Repeat for Qoder, WorkBuddy and WorkBuddy AI; WorkBuddy reads `credits: x…`.

Qoder CN's **立即签到** claims a synthetic 50-credit campaign. A second click is
idempotent. The auto-check-in switch persists but the scheduler is intentionally
disabled in the fixture. The international account starts with a legacy 2,000-credit
trial success marker. Its initial GET must show “需重新查询官方活动”, without a
success date or reward. **立即签到** queries the synthetic trial-only campaign and
reports that it is not daily check-in; it must not POST to any campaign claim or
show “今日已签到”. Only the CN daily campaign can be claimed in this fixture.
No real tokens or claims are used; fixture HOME also isolates official runtime
discovery. Set PORT to use an available preview port (default 8087).
