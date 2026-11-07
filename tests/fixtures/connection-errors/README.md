# Connection error analysis preview fixture

Launch `connection-errors-fixture` in `.claude/launch.json` on port 8089. It uses isolated temporary HOME / DATA_DIR, synthetic OAuth values and blocked upstream requests. The Qoder test account has a synthetic SSE billing error whose recorded upstream body is longer than 4,000 characters; the trailing request ID proves that the drawer and copy action retain the full stored payload. No real credentials or network calls are used.
