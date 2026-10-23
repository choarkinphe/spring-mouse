import { incrementHotCounter, resetHotCounter } from "./hotCache.js";

// Round-robin rotation for combos, shared by every worker.
//
// The engine used to keep this in a module-level Map, which meant two workers
// each started at index 0 (so the "rotation" sent the same model twice in a
// row) and a restart silently reset it. A monotonic counter in Redis gives
// every worker the same answer with no read-modify-write race: each request
// claims the next number and derives the index from it.
//
// A missing Redis (or a timeout) returns null; the engine then falls back to
// its in-process cursor, so routing still works single-process.
const COUNTER_TTL_SECONDS = 6 * 60 * 60;

function counterKey(comboKey) {
  return `combo-rotate:${comboKey}`;
}

/**
 * Claim this request's 1-based position in the combo's rotation.
 * @param {string} comboKey - Stable combo id (never the name: names are mutable).
 * @returns {Promise<number|null>} null when no shared counter is available.
 */
export async function claimComboRotationCount(comboKey) {
  if (!comboKey) return null;
  return incrementHotCounter(counterKey(comboKey), COUNTER_TTL_SECONDS);
}

/**
 * Restart a combo's rotation from the first member.
 * Called when the members, strategy, or identity change, so the new
 * configuration takes effect on the very next request instead of after the
 * cursor walks back around.
 */
export async function resetComboRotationCount(comboKey) {
  if (!comboKey) return false;
  return resetHotCounter(counterKey(comboKey));
}
