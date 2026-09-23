// `usageDaily` was a pre-aggregated cache of usageHistory keyed by date, written
// as a JSON blob. It has been unreachable for a while:
//   - migration 004 stopped trusting it and deleted its rows (the blobs cached
//     raw API key values);
//   - the stats rewrite dropped the `useDailySummary` read branch, so nothing
//     reads it;
//   - nothing writes it either — the daily write path went away with the same
//     rewrite.
// Every period (today / 7d / 30d / all) now aggregates `usageHistory` directly,
// so the table is dead weight. Drop it rather than leave a misleading schema.
//
// Reversible in principle: the data is a derived cache and can be rebuilt from
// usageHistory, which is the source of truth.
export default {
  version: 20,
  name: "drop-usage-daily",
  up(db) {
    db.exec(`DROP TABLE IF EXISTS usageDaily`);
  },
};
