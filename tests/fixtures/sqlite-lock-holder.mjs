// Test fixture: a separate OS process that holds the SQLite write lock for a
// fixed time, so a test can prove the app-side BEGIN IMMEDIATE waits (honors
// busy_timeout) instead of failing SQLITE_BUSY_SNAPSHOT.
//
// Usage: node sqlite-lock-holder.mjs <db-file> <hold-ms>
// Emits one JSON line {"event":"locked"} once the write lock is held, then
// {"event":"released"} after COMMIT.
import { DatabaseSync } from "node:sqlite";

const [file, holdMsRaw] = process.argv.slice(2);
const holdMs = Number(holdMsRaw) || 0;
const db = new DatabaseSync(file);
db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
db.exec("CREATE TABLE IF NOT EXISTS lockProbe(id INTEGER)");
db.exec("BEGIN IMMEDIATE");
db.exec("INSERT INTO lockProbe(id) VALUES(1)");
process.stdout.write(JSON.stringify({ event: "locked" }) + "\n");
await new Promise((r) => setTimeout(r, holdMs));
db.exec("COMMIT");
process.stdout.write(JSON.stringify({ event: "released" }) + "\n");
db.close();
