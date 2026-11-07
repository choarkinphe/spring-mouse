// Small, synchronous transaction primitive shared by the standalone writers and
// the web adapter. SQLite write transactions must not span an `await`: all work
// inside `fn` is synchronous so no other task can inherit this connection's
// transaction between BEGIN and COMMIT.
export function runSqliteTransaction(database, fn) {
  const outermost = !database.isTransaction;
  const name = `sm_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  database.exec(outermost ? "BEGIN IMMEDIATE" : `SAVEPOINT ${name}`);

  // Track the boundary actually owned by this invocation, not a shared nesting
  // counter. A direct writer may interleave at an await outside this function;
  // RELEASE/ROLLBACK must still target this invocation's own savepoint.
  let finished = false;
  try {
    const value = fn();
    if (value && typeof value.then === "function") {
      throw new TypeError("SQLite transaction callback must be synchronous");
    }
    database.exec(outermost ? "COMMIT" : `RELEASE ${name}`);
    finished = true;
    return value;
  } finally {
    if (!finished && database.isTransaction) {
      try {
        if (outermost) database.exec("ROLLBACK");
        else database.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      } catch (cleanupError) {
        // A failed savepoint rollback may leave its outer transaction active.
        // Never let a diagnostic writer pin the database's write lock forever.
        try { database.exec("ROLLBACK"); } catch {}
        console.error("[DB] transaction cleanup failed; forced full rollback:", cleanupError?.message || cleanupError);
      }
    }
  }
}

export function isSqliteBusy(error) {
  return Number(error?.errcode) % 256 === 5
    || error?.code === "SQLITE_BUSY"
    || /database is locked|database busy|SQLITE_BUSY/i.test(String(error?.message || error));
}
