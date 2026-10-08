import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

// The caller has stopped the OWNED smoke container. Copy the entire stopped
// SQLite file set into scratch storage: sql.js reads only the main file and
// misses schema/rows still in WAL after multi-process shutdown.
export function readPersistence(directory) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-db-read-"));
  let db;
  try {
    for (const suffix of ["", "-wal", "-shm"]) {
      const source = path.join(directory, `data.sqlite${suffix}`);
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(scratch, `data.sqlite${suffix}`));
    }
    db = new DatabaseSync(path.join(scratch, "data.sqlite"), { readOnly: true });
    const count = (query) => Number(db.prepare(query).get().n);
    return {
      usageRows: count("SELECT COUNT(*) n FROM usageHistory"),
      attempts: count("SELECT COUNT(*) n FROM routingAttempts"),
      completedAttempts: count("SELECT COUNT(*) n FROM routingAttempts WHERE outcome='valid_terminal'"),
      selectedAccounts: count("SELECT COUNT(DISTINCT connectionId) n FROM routingAttempts WHERE connectionId IS NOT NULL"),
    };
  } finally {
    db?.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = readPersistence("/app/data/db");
  console.log(JSON.stringify(result));
  if (result.usageRows < 12 || result.completedAttempts < 12 || result.selectedAccounts < 2) process.exit(1);
}
