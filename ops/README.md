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
