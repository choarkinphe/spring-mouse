// Backfill combo routing metadata added after the original schema, including
// the per-combo public capability declaration.
const ADDITIONS = [
  ["isActive", "INTEGER DEFAULT 1"],
  ["groupName", "TEXT"],
  ["sortOrder", "INTEGER DEFAULT 0"],
  ["capabilities", "TEXT NOT NULL DEFAULT '{}'"],
];

export default {
  version: 10,
  name: "combo-routing-metadata-and-capabilities",
  up(db) {
    const columns = new Set(db.all(`PRAGMA table_info(combos)`).map((row) => row.name));
    for (const [name, definition] of ADDITIONS) {
      if (!columns.has(name)) db.exec(`ALTER TABLE combos ADD COLUMN ${name} ${definition}`);
    }
  },
};
