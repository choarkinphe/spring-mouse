// Rename the CodeBuddy channels to WorkBuddy, preserving every saved account.
//
//   codebuddy-cn   → workbuddy     (copilot.tencent.com, CN rewards)
//   codebuddy-intl → workbuddy-ai  (www.codebuddy.ai tokens)
//
// Why: the upstream product was renamed. Re-authorizing every account would
// throw away working refresh tokens (and the CN UID that daily check-in is keyed
// by), so the stored credentials are moved in place instead.
//
// The new provider ids demand a credential contract (open-sse/config/workbuddy.js):
// product, origin, platform, contract and host binding for a normal account, plus
// a UID. `codebuddyUid` is carried over when it exists and is never invented — an
// account without one keeps working for chat and remains ineligible for check-in,
// exactly as before. An international credential was issued by www.codebuddy.ai
// and cannot claim the *.workbuddy.ai contract, so it is marked
// `workbuddyLegacyCredential` and keeps its original endpoint origin; the marker
// exists only so an operator can see (and roll back to) where the tokens came
// from.
//
// Model strings are deliberately NOT rewritten. The WorkBuddy registry entries
// keep the `cbcn` / `cbai` aliases, so existing `cbcn/...` combos, model aliases,
// disabled-model lists and capability overrides resolve unchanged. Rewriting
// stored text would risk mutating user-authored aliases for no benefit.
//
// Everything is conservative: a row whose JSON cannot be parsed, or whose
// providerSpecificData is not an object, is left exactly as it was. Running the
// migration twice writes nothing the second time.

const RENAMES = [
  {
    from: "codebuddy-cn",
    to: "workbuddy",
    metadata: {
      workbuddyProduct: "workbuddy",
      workbuddyOrigin: "https://copilot.tencent.com",
      workbuddyPlatform: "workbuddy",
      workbuddyContract: "0.1.30",
      domain: "copilot.tencent.com",
      // CN tokens were issued by the CodeBuddy implementation too. Keeping the
      // legacy marker means the account keeps the exact request transform,
      // refresh call and headers it had before the rename — a production account
      // that worked yesterday must still work after the upgrade, without a
      // re-login. Only accounts authorized by this build use the new contract.
      workbuddyLegacyCredential: true,
      workbuddyLegacyOrigin: "https://copilot.tencent.com",
      workbuddyEndpointOrigin: "https://copilot.tencent.com",
    },
  },
  {
    from: "codebuddy-intl",
    to: "workbuddy-ai",
    metadata: {
      workbuddyProduct: "workbuddy-ai",
      workbuddyOrigin: "https://www.workbuddy.ai",
      workbuddyPlatform: "workbuddy-ai",
      workbuddyContract: "0.1.30",
      // Tokens were issued by the old international host. The legacy path uses
      // workbuddyEndpointOrigin for chat, refresh and usage, so the account keeps
      // talking to the host that issued its credentials. workbuddyLegacyOrigin is
      // the operator-visible audit trail of that origin.
      workbuddyLegacyCredential: true,
      workbuddyLegacyOrigin: "https://www.codebuddy.ai",
      workbuddyEndpointOrigin: "https://www.codebuddy.ai",
    },
  },
];

const CHECKIN_SCOPE = "codebuddyCheckin";
const CHECKIN_PREFIX = "account:codebuddy-cn:";
const CHECKIN_REPLACEMENT = "account:workbuddy:";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function migrateConnections(db, { from, to, metadata }) {
  // The provider column is the idempotency key: once renamed, a second run finds
  // no rows here.
  const rows = db.all(`SELECT id, data FROM providerConnections WHERE provider = ?`, [from]);
  for (const row of rows) {
    let parsed;
    try {
      parsed = JSON.parse(row.data || "{}");
    } catch {
      continue; // Preserve a malformed row rather than risk destroying it.
    }
    if (!isRecord(parsed)) continue;
    const current = parsed.providerSpecificData;
    // A non-object blob cannot be merged without discarding whatever evidence it
    // held, and half-migrating (renaming the provider but losing the binding)
    // would break the account. Leave the whole row alone for a human to inspect.
    if (current !== undefined && !isRecord(current)) continue;
    db.run(
      `UPDATE providerConnections SET provider = ?, data = ? WHERE id = ?`,
      [to, JSON.stringify({ ...parsed, providerSpecificData: { ...(current || {}), ...metadata } }), row.id],
    );
  }
}

// kv has no timestamp: pick the row whose own check-in state is newer, and keep
// the already-migrated row when neither can be ordered.
function checkinTimestamp(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  let newest = null;
  const candidates = [
    parsed.lastAttemptAt,
    parsed.lastSuccessDate,
    parsed.terminalDate,
    parsed.leaseUntil,
    parsed.retryAfter,
  ];
  for (const candidate of candidates) {
    const ms = typeof candidate === "number" ? candidate : Date.parse(candidate);
    if (Number.isFinite(ms) && (newest === null || ms > newest)) newest = ms;
  }
  return newest;
}

function migrateCheckinKeys(db) {
  // Only UID-keyed account rows move. The per-connection `enabled` switches are
  // keyed by connection id and stay untouched.
  const rows = db.all(
    `SELECT key, value FROM kv WHERE scope = ? AND key LIKE ?`,
    [CHECKIN_SCOPE, `${CHECKIN_PREFIX}%`],
  );
  for (const row of rows) {
    const uid = row.key.slice(CHECKIN_PREFIX.length);
    if (!uid) continue; // Not a UID-keyed row; leave it.
    const nextKey = `${CHECKIN_REPLACEMENT}${uid}`;
    const existing = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [CHECKIN_SCOPE, nextKey]);

    if (!existing) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES(?, ?, ?)`, [CHECKIN_SCOPE, nextKey, row.value]);
    } else {
      const legacyMs = checkinTimestamp(row.value);
      const existingMs = checkinTimestamp(existing.value);
      // The old row wins only when it is provably newer; otherwise the row under
      // the new key is the edited/current one and is kept.
      if (legacyMs !== null && existingMs !== null && legacyMs > existingMs) {
        db.run(`UPDATE kv SET value = ? WHERE scope = ? AND key = ?`, [row.value, CHECKIN_SCOPE, nextKey]);
      }
    }
    db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [CHECKIN_SCOPE, row.key]);
  }
}

const migration = {
  version: 27,
  name: "codebuddy-to-workbuddy",
  up(db) {
    for (const rename of RENAMES) migrateConnections(db, rename);
    migrateCheckinKeys(db);
  },
};

export default migration;
