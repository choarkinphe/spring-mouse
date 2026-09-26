#!/bin/sh
# Codex forced-streaming idle-watchdog watch. Read-only.
#
# TIMESTAMP FORMAT: stored values are ISO-8601 UTC with a `T` separator. SQLite's
# datetime() emits a SPACE separator, and comparing the two as strings is wrong
# ('T' > ' '), so every row from the same day matches a "-1 hour" window. Always
# compare with strftime('%Y-%m-%dT%H:%M:%SZ', ...).
LC_ALL=C
ISO="strftime('%Y-%m-%dT%H:%M:%SZ','now'"
DB=/www/docker/spring-mouse/data/db/data.sqlite
S='s/^\[[0-9: ]+\] *//'

echo "### NOW_UTC"; date -u '+%Y-%m-%dT%H:%M:%SZ'
echo "### CONTAINER"
docker inspect spring-mouse --format 'REV={{index .Config.Labels "org.opencontainers.image.revision"}} HEALTH={{.State.Health.Status}}'
echo "### DEPLOYED_AT"; docker inspect spring-mouse --format '{{.State.StartedAt}}'

echo "### WATCHDOG FIRED (the new signal; errorLine survives LOG_LEVEL=WARN)"
docker logs spring-mouse 2>&1 | grep -ac "STALL TIMEOUT" || true
docker logs spring-mouse 2>&1 | grep -a "STALL TIMEOUT" | sed -E "$S" | tr -cd '\11\12\15\40-\176' | tail -5

echo "### CODEX OUTCOMES (last 1h)"
sqlite3 -readonly $DB "SELECT status, COUNT(*) FROM usageHistory WHERE provider='codex' AND timestamp >= $ISO,'-1 hour') GROUP BY status ORDER BY 2 DESC;" 2>&1

echo "### STUCK TURNS (cancelled, last 1h) - should be dropping"
sqlite3 -readonly $DB "SELECT substr(timestamp,12,8), model, substr(COALESCE(connectionId,'-'),1,8), CAST(ROUND((julianday(COALESCE(completedAt,timestamp))-julianday(COALESCE(startedAt,timestamp)))*86400) AS INT) FROM usageHistory WHERE provider='codex' AND status='cancelled' AND timestamp >= $ISO,'-1 hour') ORDER BY timestamp DESC LIMIT 8;" 2>&1

echo "### CLIENT-FACING 5xx (last 1h, codex only)"
sqlite3 -readonly $DB "SELECT COALESCE(nt.statusCode,-1), COUNT(*) FROM usageHistory uh JOIN networkTraffic nt ON nt.requestId=uh.trafficRequestId WHERE uh.provider='codex' AND nt.statusCode >= 500 AND nt.timestamp >= $ISO,'-1 hour') GROUP BY 1;" 2>&1

echo "### ACCOUNT USE (last 1h) - is the bad account still in rotation?"
sqlite3 -readonly $DB "SELECT substr(COALESCE(connectionId,'-'),1,8), COUNT(*), SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) cancelled FROM usageHistory WHERE provider='codex' AND timestamp >= $ISO,'-1 hour') GROUP BY 1 ORDER BY 2 DESC;" 2>&1

echo "### DONE"
