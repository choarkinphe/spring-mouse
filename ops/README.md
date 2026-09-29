# ops/ — production monitoring & housekeeping

Scripts that run **against the production host**, not part of the app bundle.
They lived only on the WSL box and the server until now; keeping them here means a
rebuilt environment does not silently lose the overload monitor or the disk
guard.

None of these are imported by the app. Changing them does not require a release —
copy the file to the host and (for cron) reinstall it. That is exactly why they
are easy to forget; this README is the checklist.

## What runs where

| Script | Runs on | Installed at | Driven by |
|---|---|---|---|
| `sm-overload-monitor.sh` | WSL (drives ssh) | `~/.claude/scripts/` | the `spring-mouse-overload-monitor` scheduled task (every 15 min) |
| `sm-clean-requestlogs.sh` | production host | `/usr/local/bin/` | root crontab, every 5 min |
| `sm-scan-dumps.sh` | inside the container | `/app/data/sm-tools/` (bind-mounted from `<deploy>/data/sm-tools/`) | called by `sm-overload-monitor.sh` |
| `sm-query.js` | inside the container | `/app/data/sm-tools/` | ad hoc: `sm-q.sh recent N` / `errors N` / `overload N` |
| `sm-deploy-rollback.sh` | production host | `/tmp/` (ad hoc) | pre-deploy backup, deploy, and one-command rollback |
| `sm-stream-diag-collect.sh` | production host | `/tmp/` (ad hoc) | the session's stream-diagnostic collector (every 30 min) |

## Why each exists
**`sm-overload-monitor.sh`** — one ssh round-trip that prints a single JSON line
(the app's own stdout is long and gets truncated by the harness, which once made
the task retry for 17 minutes). Fields worth knowing:

- `retrying` / `retry_lines` / `recovered` / `exhausted` — the overload retry arc,
  counted from `docker logs` since the container started.
- `dump_client_hits` — **the real escape signal**: the gateway forwarded an
  overload frame to the client as normal output. `exhausted>0` with
  `dump_client_hits=0` is healthy (the gateway correctly returned 503).
- `dump_enabled` / `dump_newest` — dump health. These were added after the dumps
  silently stopped (the DB setting had been turned off and the process kept
  serving a cached value), which quietly blinded the escape check.
- Exit code means "did collection succeed", not "was anything wrong".

**`sm-clean-requestlogs.sh`** — keeps `data/request-logs` bounded. Two guards:
age (`KEEP_MIN`, default 60) and total size (`MAX_MB`), plus a disk-pressure
backstop (`MIN_FREE_MB`) that tightens `MAX_MB` to half the free space so dumps can
never fill the production disk.

> The size cap must sit **well above** the steady state. At 3072MB against a
> ~3070MB steady state the cleaner deleted forever and eventually wiped every
> directory including active ones; it is 6144MB now. If you lower it, check
> `size=` in `/var/log/sm-requestlog-clean.log` first.

**`sm-scan-dumps.sh`** — answers "which hop produced the overload?" by reading the
per-request dumps: `5_res_provider.txt` is the upstream's raw SSE and
`7_res_client.txt` is what the gateway sent the client. A hit in 5 only means the
gateway retried; a hit in 7 means it escaped. It matches the **error-frame
structure** (`"code":"server_is_overloaded"`), not the bare phrase — a debugging
conversation that merely quotes the message would otherwise register as a hit.

**`sm-deploy-rollback.sh`** — the one-command backup / deploy / rollback for a
production release. Two things make it worth using instead of hand-rolled steps:

- **Function rollback does not depend on Docker Hub.** `latest` is mutable, so a
  pull after a bad release can hand you the same bad image. The script tags the
  running image locally as `spring-mouse:pre-<rev>-<ts>` at backup time and rolls
  back to that tag, never pulling.
- **The DB snapshot uses `VACUUM INTO`, not `cp` and not `.backup`.** The live DB
  is in WAL mode, so a `cp` is a torn snapshot. `sqlite3 .backup` is consistent
  but **not convergent**: it restarts from page 1 whenever the source is written
  during the copy, so against a DB under continuous write it never finishes —
  this is what filled a host's disk and froze its snapshot. `VACUUM INTO` is a
  single streaming pass that always terminates, and it is wrapped in `timeout`
  so a stuck snapshot can never block a deploy. Snapshot failure is logged and
  **non-blocking**: a deploy proceeds without one rather than hanging.

Migration compatibility is what makes the two rollbacks separable: the migration
chain is **forward and skip-version safe** (`src/lib/db/migrate.js` filters
`m.version > current`), so an older image on a newer DB simply applies nothing —
it does not fail. A migration that only ADDS tables (e.g. 024) therefore leaves
nothing for the old image to trip over, and **rolling back the function does not
require rolling back the DB**. Only reach for `rollback-db` when data was written
wrong, and note it discards everything after the backup point.

```bash
sh sm-deploy-rollback.sh backup          # before a release
sh sm-deploy-rollback.sh deploy <REV>    # backup → pull → up → health + smoke
sh sm-deploy-rollback.sh rollback        # function only (local tag)
sh sm-deploy-rollback.sh rollback-db     # data only (needs `yes`)
sh sm-deploy-rollback.sh list | verify
```

`verify` finishes with a real `POST /v1/chat/completions` smoke test and treats a
**500** as the signal to roll back — a plain health check would not have caught
the observer-interface bug, which returned a healthy process that 500'd on every
chat request.

**`sm-stream-diag-collect.sh`** — one read-only round-trip that prints everything the
30-minute monitoring check needs, so the check does not have to grep by hand each
time. It reports four things:

- **`SCAN BOUNDS`** — the ceiling's log line and any unresolved scan stop. The scan
  has two time bounds and they are deliberately ordered:
  `CODEX_SSE_PREAMBLE_MS` (default **60s**, the phase bound, the normal stop) and
  `CODEX_SSE_SCAN_MAX_MS` (default **120s**, a ceiling that sits ABOVE it). **A run
  where the ceiling never appears is the NORMAL case, not a defect** — it fires only
  when the phase bound is disabled or raised past it. Reading `ceiling=0` as "the
  guard is broken" is how a 5s/10s pair once reached production and cost ~15 x 503
  per minute.
- **`STAGE DIAGNOSTICS`** — `CODEX-STAGE` / `CHATCORE-STAGE` / `FETCH-STAGE` counts.
  These timers fire at 30s **while a phase is still running**, so a line means that
  phase had not finished after 30s — it does NOT mean the phase is stuck. Under the
  60s phase bound a scan is allowed to run that long, so these are expected on slow
  turns and are only interesting in bulk.
- **`VISIBLE STALL`** — the client-starvation watchdog (`starved the client`). This
  is the one that fires on the real failure: the upstream keeps sending while the
  client receives almost nothing.
- **`STREAM-DIAG`** — upstream bytes vs client-visible bytes, the measurement three
  failed fixes never took.

Background on the bytes: a Codex turn can run past 300s and end as `cancelled` with
the request-detail row still holding the `[Streaming in progress...]` placeholder and
`ttft=0`. That looked like "the upstream went silent", so a stall timer was added to
the streaming pipe — but it never fired. It then looked like "the wrong path", so an
idle watchdog was added to the forced-streaming read — it never fired either. Both
were falsified, because the evidence contradicted itself: the record said nothing was
produced, while the dumps showed hundreds of KB of metadata frames arriving the whole
time.

The missing measurement is the pair. The two taps log through `errorLine` (so they
survive `LOG_LEVEL=WARN`) and only for turns past 60s:

| `up_bytes` | `vis_bytes` | reading |
|---|---|---|
| large | **tiny** | stalled — the transform produced almost nothing |
| large | large | healthy, merely slow |
| tiny | tiny | upstream genuinely silent |

First production samples already split the two shapes at the same upstream volume
(~714KB): `codex/gpt-6-astra` converted it to **10KB** for the client, while
`glm-cn/glm-5.3-flash` converted it to **700KB**. Note `first_vis_ms=16` on the
first — the client gets a `message_start` almost immediately, which is why any
"no output yet" watchdog is satisfied and never fires. The signal is the RATIO,
not the presence or absence of bytes.

> Historical note: the `STALL TIMEOUT` signal (and the watchdog that emitted it)
> belonged to a fix that was reverted — it never fired on the real failure, because
> the upstream keeps sending metadata frames and any byte-based timer is reset by
> them. Do not read a quiet `STALL TIMEOUT` as "healthy".

> On sizing the two scan bounds: size them from how long a HEALTHY turn takes to
> produce its first output (24h measured: 591 turns at 15-25s, 165 at 25-40s, 47 at
> 40-60s, 22 past 60s, max 245s) — NOT from how long an overload frame takes to
> arrive (0-23s). Sizing from the frame arrival is a mistake this repo has made; it
> briefly shipped a 25s bound that truncated healthy turns and took upstream:503
> from 0.06/min to 0.70/min.

Timestamps: the DB stores ISO-8601 UTC with a `T` separator, while SQLite's
`datetime()` emits a SPACE. Comparing them as strings is wrong (`'T'` > `' '`), so
every row from the same day matches a `-1 hour` window and the monitor reports
failures that are hours old. Always compare with
`strftime('%Y-%m-%dT%H:%M:%SZ', ...)`.

## Reinstalling after a rebuild

```bash
# production host
scp sm-clean-requestlogs.sh root@192.168.86.72:/usr/local/bin/
ssh root@192.168.86.72 'chmod +x /usr/local/bin/sm-clean-requestlogs.sh'
ssh root@192.168.86.72 '(crontab -l | grep -v sm-clean-requestlogs; \
  echo "*/5 * * * * KEEP_MIN=60 MAX_MB=6144 MIN_FREE_MB=3000 /usr/local/bin/sm-clean-requestlogs.sh >/dev/null 2>&1") | crontab -'

# into the container (bind-mounted, so it survives restarts)
scp sm-scan-dumps.sh sm-query.js root@192.168.86.72:/www/docker/spring-mouse/data/sm-tools/

# WSL
cp sm-overload-monitor.sh ~/.claude/scripts/ && chmod +x ~/.claude/scripts/sm-overload-monitor.sh
```

## Notes

- `sm-scan-dumps.sh` is `sh`, not `bash` — the container image has no bash.
- `sm-overload-monitor.sh` and `sm-query.js` render times in **CST**; the DB stores
  UTC ISO and the app buckets days in `Asia/Shanghai`.
- Editing these through the Windows filesystem can drop the executable bit; the
  monitor task calls the script as `bash <path>` for that reason.
