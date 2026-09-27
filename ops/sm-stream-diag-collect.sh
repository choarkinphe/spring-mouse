#!/bin/sh
# Diagnostic collector for the "Codex turn never produces output" investigation.
#
# Read-only. This does NOT watch a fix (three fixes were already falsified); it
# collects the measurement that has never been taken: upstream bytes vs
# client-visible bytes for every turn that ran past 60s.
#
# The decision table the samples feed:
#   up_bytes large + vis_bytes tiny  -> stalled (transform produced nothing)
#   up_bytes large + vis_bytes large -> healthy, merely slow
#   up_bytes tiny  + vis_bytes tiny  -> upstream genuinely silent
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
