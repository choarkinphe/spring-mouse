// Explicit slot moves for provider connections.
//
// The account drawer's Priority field is a *position* ("3" = "become the 3rd
// account"), but the weight-then-renumber path in connectionsRepo.reorderInTx()
// reads the same number as a sort weight: the moved row ties with the row it
// displaced and wins the tie on `updatedAt`, so asking for slot 3 lands on
// slot 2 and the typed number is silently rewritten. Pulling the row out first
// and renumbering afterwards keeps the number the user typed honest.
//
// The up/down arrows keep calling reorderInTx — for a single-step swap that
// path is already correct, so this module deliberately does not replace it.
import { getAdapter } from "../driver.js";
import { parseJson } from "../helpers/jsonCol.js";

function rowToConn(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  return {
    ...extra,
    id: row.id,
    provider: row.provider,
    authType: row.authType,
    name: row.name,
    email: row.email,
    priority: row.priority,
    mouseId: row.mouseId || null,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Mirrors the tie-break in reorderInTx so "the current order" is read the same
// way in both places.
function byCurrentOrder(a, b) {
  const diff = (a.priority || 0) - (b.priority || 0);
  if (diff !== 0) return diff;
  return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
}

/**
 * Move one connection into slot `position` (1-based) and renumber the channel
 * 1..N. Out-of-range positions clamp to the first/last slot instead of failing,
 * so a stale drawer holding an old account count still does something sensible.
 */
export async function moveProviderConnectionToPosition(id, position) {
  const db = await getAdapter();
  let result;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
    if (!row) {
      result = null;
      return;
    }

    const list = db
      .all(`SELECT * FROM providerConnections WHERE provider = ?`, [row.provider])
      .map(rowToConn)
      .sort(byCurrentOrder);

    const from = list.findIndex((conn) => conn.id === id);
    if (from === -1) {
      result = null;
      return;
    }

    const target = Math.min(Math.max(1, Math.floor(Number(position) || 1)), list.length) - 1;
    const [moved] = list.splice(from, 1);
    list.splice(target, 0, moved);

    list.forEach((conn, index) => {
      db.run(`UPDATE providerConnections SET priority = ? WHERE id = ?`, [index + 1, conn.id]);
    });

    result = { ...moved, priority: target + 1 };
  });
  return result;
}
