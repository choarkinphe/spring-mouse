// Remove the retired provider proxy-pool feature and its per-connection links.
const migration = {
  version: 2,
  name: "remove-proxy-pools",
  up(db) {
    const rows = db.all(`SELECT id, data FROM providerConnections`);
    for (const row of rows) {
      try {
        const data = JSON.parse(row.data || "{}");
        if (!data?.providerSpecificData || !("proxyPoolId" in data.providerSpecificData)) continue;
        delete data.providerSpecificData.proxyPoolId;
        db.run(`UPDATE providerConnections SET data = ? WHERE id = ?`, [JSON.stringify(data), row.id]);
      } catch {
        // Keep malformed historical rows untouched; repository reads already fail-safe.
      }
    }

    db.exec(`DROP TABLE IF EXISTS proxyPools`);
  },
};

export default migration;
