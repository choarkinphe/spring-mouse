// Key per-combo routing strategies by the combo's stable id, not its name.
//
// BEFORE: settings.comboStrategies = { "<combo name>": { fallbackStrategy, ... } }
// AFTER:  settings.comboStrategies = { "<combo id>":   { fallbackStrategy, ... } }
//
// Why: a name is mutable. Renaming a combo left the strategy under the old name
// and the combo silently fell back to plain fallback routing — the operator saw
// their fusion/auto configuration vanish with no error. An id cannot drift.
//
// Unknown keys are preserved verbatim: a strategy whose combo was deleted, or
// whose name collides with nothing yet, must not be destroyed by a migration.
// Two names mapping onto the same id keep the first occurrence (Object.entries
// order), which is the entry that was visible last in the settings row.

import { remapComboStrategyKeys } from "../../../../open-sse/services/comboStrategy.js";

const migration = {
  version: 26,
  name: "combo-strategy-by-id",
  up(db) {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    if (!row) return;

    let settings;
    try {
      settings = JSON.parse(row.data || "{}");
    } catch {
      return; // Preserve a malformed row rather than risk destroying it.
    }

    const strategies = settings.comboStrategies;
    if (!strategies || typeof strategies !== "object" || Array.isArray(strategies)) return;
    if (Object.keys(strategies).length === 0) return;

    const combos = db.all(`SELECT id, name FROM combos`);
    const remapped = remapComboStrategyKeys(strategies, combos);

    // Nothing to do when every key already names a combo id (or no combo at
    // all matched): leave the row untouched so an unchanged install writes
    // nothing during upgrade.
    const unchanged = Object.keys(remapped).length === Object.keys(strategies).length
      && Object.keys(strategies).every((key) => Object.hasOwn(remapped, key) && remapped[key] === strategies[key]);
    if (unchanged) return;

    settings.comboStrategies = remapped;
    db.run(`UPDATE settings SET data = ? WHERE id = 1`, [JSON.stringify(settings)]);
  },
};

export default migration;
