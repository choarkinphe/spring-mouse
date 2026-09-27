#!/bin/sh
# Diagnostic collector for the "Codex turn never produces output" investigation.
#
# Read-only. It answers two questions in one round-trip: whether a Codex turn is
# starving the CLIENT (upstream bytes vs client-visible bytes), and which SSE-scan
# bound stopped a turn that produced nothing.
#
# The decision table the STREAM-DIAG samples feed:
#   up_bytes large + vis_bytes tiny  -> stalled (transform produced nothing)
#   up_bytes large + vis_bytes large -> healthy, merely slow
#   up_bytes tiny  + vis_bytes tiny  -> upstream genuinely silent
#
# The SCAN BOUNDS section is the other half. The scan has TWO time bounds and they
# are deliberately ordered:
#
#   CODEX_SSE_PREAMBLE_MS  (default 60s)  the phase bound; the normal stop
#   CODEX_SSE_SCAN_MAX_MS  (default 120s) the ceiling; a guard that sits ABOVE it
#
# A run where the ceiling's line never appears is the NORMAL case, not a defect —
# the ceiling only fires when the phase bound is disabled or raised past it. Do not
# read "ceiling=0" as "the guard is broken"; that misreading is how a 5s/10s pair
# once reached production and cost ~15 x 503 per minute.
#
# Both bounds were also briefly set too low from the wrong measurement (an overload
# frame arrives in 0-23s, but these bound how long a HEALTHY turn may take to first
# output, which runs to 245s). The signal to watch is not the bound firing but
# `cancelled > 180s` staying at zero and upstream:503 not rising.
#
# TIMESTAMP FORMAT: stored values are ISO-8601 UTC with a `T` separator, while
# SQLite's datetime() emits a SPACE. Comparing them as strings is wrong ('T' >
# ' '), so every row from the same day matches a "-1 hour" window. Always compare
# with strftime('%Y-%m-%dT%H:%M:%SZ', ...).
LC_ALL=C
ISO="strftime('%Y-%m-%dT%H:%M:%SZ','now'"
DB=/www/docker/spring-mouse/data/db/data.sqlite
S='s/^\[[0-9: ]+\] *//'

echo "### NOW_UTC"; date -u '+%Y-%m-%dT%H:%M:%SZ'
echo "### CONTAINER"
docker inspect spring-mouse --format 'REV={{index .Config.Labels "org.opencontainers.image.revision"}} HEALTH={{.State.Health.Status}}'
echo "### DEPLOYED_AT"; docker inspect spring-mouse --format '{{.State.StartedAt}}'

echo "### SCAN BOUNDS (ceiling + unresolved stops) - see the header for why 0 is normal"
echo "ceiling_fired:  $(docker logs spring-mouse 2>&1 | grep -ac 'total ceiling' || true)"
echo "scan_stopped:   $(docker logs spring-mouse 2>&1 | grep -ac 'scan stopped on the' || true)"
docker logs spring-mouse 2>&1 | grep -a -E 'total ceiling|scan stopped on the' | sed -E "$S" | tr -cd '\11\12\15\40-\176' | tail -10

echo "### STAGE DIAGNOSTICS (>30s in one phase; a 30s line means the phase was STILL running)"
echo "CODEX-STAGE:    $(docker logs spring-mouse 2>&1 | grep -ac 'CODEX-STAGE' || true)"
echo "CHATCORE-STAGE: $(docker logs spring-mouse 2>&1 | grep -ac 'CHATCORE-STAGE' || true)"
echo "FETCH-STAGE:    $(docker logs spring-mouse 2>&1 | grep -ac 'FETCH-STAGE' || true)"
docker logs spring-mouse 2>&1 | grep -a -E 'CODEX-STAGE|CHATCORE-STAGE|FETCH-STAGE' | sed -E "$S" | tr -cd '\11\12\15\40-\176' | tail -10

echo "### VISIBLE STALL (client starved while upstream kept sending)"
echo "count: $(docker logs spring-mouse 2>&1 | grep -ac 'starved the client' || true)"
docker logs spring-mouse 2>&1 | grep -a 'starved the client' | sed -E "$S" | tr -cd '\11\12\15\40-\176' | tail -8

echo "### STREAM-DIAG samples (streaming pipe)"
docker logs spring-mouse 2>&1 | grep -a "STREAM-DIAG" | sed -E "$S" | tr -cd '\11\12\15\40-\176' | tail -25
echo "### count: $(docker logs spring-mouse 2>&1 | grep -ac 'STREAM-DIAG' || true)"

echo "### SSE2JSON-DIAG samples (forced-streaming-to-JSON read)"
docker logs spring-mouse 2>&1 | grep -a "SSE2JSON-DIAG" | sed -E "$S" | tr -cd '\11\12\15\40-\176' | tail -25
echo "### count: $(docker logs spring-mouse 2>&1 | grep -ac 'SSE2JSON-DIAG' || true)"

echo "### STUCK TURNS (cancelled >180s, last 6h) - to correlate against the samples"
sqlite3 -readonly $DB "SELECT substr(timestamp,12,8), model, substr(COALESCE(connectionId,'-'),1,8), CAST(ROUND((julianday(COALESCE(completedAt,timestamp))-julianday(COALESCE(startedAt,timestamp)))*86400) AS INT) FROM usageHistory WHERE provider='codex' AND status='cancelled' AND CAST(ROUND((julianday(COALESCE(completedAt,timestamp))-julianday(COALESCE(startedAt,timestamp)))*86400) AS INT) > 180 AND timestamp >= $ISO,'-6 hours') ORDER BY timestamp DESC LIMIT 10;" 2>&1

echo "### SLOW SUCCESSES (>60s, last 6h) - the control group the samples must not flag"
sqlite3 -readonly $DB "SELECT COUNT(*), MAX(CAST(nt.durationMs/1000 AS INT)) FROM usageHistory uh JOIN networkTraffic nt ON nt.requestId=uh.trafficRequestId WHERE uh.provider='codex' AND uh.status='success' AND nt.durationMs > 60000 AND nt.timestamp >= $ISO,'-6 hours');" 2>&1

echo "### CODEX OUTCOMES (last 6h)"
sqlite3 -readonly $DB "SELECT status, COUNT(*) FROM usageHistory WHERE provider='codex' AND timestamp >= $ISO,'-6 hours') GROUP BY status ORDER BY 2 DESC;" 2>&1

echo "### DONE"
