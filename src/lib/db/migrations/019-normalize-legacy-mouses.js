import { TABLES, buildCreateTableSql } from "../schema.js";

// `mouses` predates this fork's rewrite of the table: installations that had run
// the older 9Router-era build keep a leftover shape whose `tokenHash` and
// `createdAt` are NOT NULL with no DEFAULT. Nothing can satisfy them any more, so
// every insert — i.e. "create a node" in the dashboard — dies with
// `NOT NULL constraint failed: mouses.tokenHash`.
//
// The additive auto-sync in migrate.js can only ever ADD columns, so it can never
// undo this. The only way out of SQLite's NOT NULL rule is to rebuild the table,
// which is what this does: copy the rows that still map onto the current schema,
// drop the leftovers, and recreate the declared indexes.
//
// On a healthy database (including a fresh install) the drift is absent and this
// migration is a no-op. Version 19 rather than 17: the local dev database already
// records 18 from migrations that were never committed, and the runner only looks
// at migrations numbered above the stored version.
const NORMALIZED_TABLE = "mouses__normalized";

const migration = {
  version: 19,
  name: "normalize-legacy-mouses",
  up(db) {
    const existing = db.all("PRAGMA table_info(mouses)");
    if (!existing.length) return; // No table yet — 014 creates it correctly later.

    const declared = TABLES.mouses;
    const declaredNames = Object.keys(declared.columns);
    const known = new Set(declaredNames);

    // Only an undeclared column that cannot be omitted from an INSERT is a real
    // breakage. Undeclared columns that carry a DEFAULT are just clutter.
    const blockers = existing.filter((row) => !known.has(row.name) && row.notnull === 1 && row.dflt_value === null);
    if (!blockers.length) return;

    // Rows can only be carried across for columns that exist in both shapes. If a
    // column the current schema requires (NOT NULL, no DEFAULT) is absent, the copy
    // could not be built — leave the table untouched rather than fail the boot.
    const carryable = declaredNames.filter((name) => existing.some((row) => row.name === name));
    const required = new Set(declaredNames.filter((name) => /NOT NULL/i.test(declared.columns[name])));
    const unsatisfiable = [...required].filter((name) => !carryable.includes(name));
    if (unsatisfiable.length) {
      console.warn(`[DB][migrate] mouses still needs columns ${unsatisfiable.join(", ")}; skipping normalisation`);
      return;
    }

    const before = db.get("SELECT COUNT(*) AS c FROM mouses")?.c ?? 0;
    const columns = carryable.join(", ");

    db.exec(buildCreateTableSql(NORMALIZED_TABLE, declared));
    if (carryable.length) {
      db.run(`INSERT INTO ${NORMALIZED_TABLE} (${columns}) SELECT ${columns} FROM mouses`);
    }
    db.exec("DROP TABLE mouses");
    db.exec(`ALTER TABLE ${NORMALIZED_TABLE} RENAME TO mouses`);
    // Migration 016 gave clientId a *named* unique index. The rebuilt table carries
    // the same constraint inline (declared in schema.js), but restoring the name too
    // keeps a repaired database indistinguishable from a migrated one.
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_mouse_client_id ON mouses(clientId)");
    for (const index of declared.indexes || []) {
      try {
        db.exec(index);
      } catch (error) {
        console.warn(`[DB][migrate] mouses index rebuild skipped: ${error.message}`);
      }
    }

    const after = db.get("SELECT COUNT(*) AS c FROM mouses")?.c ?? 0;
    console.log(
      `[DB][migrate] mouses rebuilt without ${blockers.map((row) => row.name).join(", ")} | rows ${before} -> ${after}`,
    );
  },
};

export default migration;
