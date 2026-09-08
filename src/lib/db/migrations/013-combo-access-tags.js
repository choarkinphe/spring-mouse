export default {
  version: 13,
  name: "combo-access-tags",
  up(db) {
    const columns = new Set(db.all("PRAGMA table_info(combos)").map((row) => row.name));
    if (!columns.has("accessTags")) {
      db.exec("ALTER TABLE combos ADD COLUMN accessTags TEXT NOT NULL DEFAULT '[]'");
    }
  },
};
