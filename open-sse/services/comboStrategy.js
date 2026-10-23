/**
 * Resolve a combo's stored routing strategy.
 *
 * Strategies live in `settings.comboStrategies`, keyed by the combo's stable
 * `id`. They used to be keyed by the combo's *name*, which made a rename
 * silently drop fusion/auto configuration: the row kept pointing at the old
 * name and the combo fell back to plain fallback routing.
 *
 * The name lookup stays as a read-only fallback so a settings row written by an
 * older build (or by hand) keeps working until migration 026 rewrites it.
 * Writers must always use `combo.id` — never the name.
 */

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * @param {Object|null|undefined} strategies - settings.comboStrategies
 * @param {{ id?: string, name?: string }|null|undefined} combo
 * @returns {Object} The strategy object, or `{}` when the combo has none.
 */
export function getComboStrategy(strategies, combo) {
  if (!isPlainObject(strategies) || !combo) return {};
  const byId = combo.id ? strategies[combo.id] : undefined;
  if (isPlainObject(byId)) return byId;
  // Legacy name key: read only, never written back.
  const byName = combo.name ? strategies[combo.name] : undefined;
  return isPlainObject(byName) ? byName : {};
}

/**
 * The key a strategy must be written under.
 *
 * Falls back to the name only when the caller has no id yet (a combo that has
 * not been persisted). Runtime paths always have the persisted row.
 */
export function comboStrategyKey(combo) {
  if (!combo) return "";
  return combo.id || combo.name || "";
}

/**
 * Rewrite a name-keyed strategy map onto combo ids.
 *
 * Used by migration 026 and by the settings writer when it receives legacy
 * shape. Idempotent: keys that already name a combo id are left alone, and a
 * key that matches neither an id nor a name is preserved as-is rather than
 * dropped (an operator may be mid-edit, or the combo may be created later).
 *
 * @param {Object} strategies
 * @param {Array<{ id: string, name: string }>} combos
 * @returns {Object}
 */
export function remapComboStrategyKeys(strategies, combos) {
  if (!isPlainObject(strategies)) return {};
  const byName = new Map();
  const ids = new Set();
  for (const combo of Array.isArray(combos) ? combos : []) {
    if (!combo?.id) continue;
    ids.add(combo.id);
    if (combo.name) byName.set(combo.name, combo.id);
  }

  const remapped = {};
  for (const [key, value] of Object.entries(strategies)) {
    const target = ids.has(key) ? key : (byName.get(key) || key);
    // Two names collapsing onto one id: keep the entry the operator actually
    // reaches through the id key, so a stale duplicate never wins.
    if (target !== key && Object.hasOwn(remapped, target)) continue;
    remapped[target] = value;
  }
  return remapped;
}
