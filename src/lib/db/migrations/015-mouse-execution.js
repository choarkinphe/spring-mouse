const migration = {
  version: 15,
  name: "mouse-execution",
  up(db) {
    const addColumn = (table, column) => {
      const columns = new Set(db.all(`PRAGMA table_info(${table})`).map((row) => row.name));
      if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
    };
    addColumn("mouses", "executionToken");
    addColumn("mouses", "callbackUrl");
  },
};

export default migration;
