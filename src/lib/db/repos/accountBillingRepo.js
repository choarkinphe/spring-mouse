import { randomUUID } from "node:crypto";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { getProviderConnectionById, getProviderConnections, updateProviderConnection } from "./connectionsRepo.js";
import { getPricingForModels } from "./pricingRepo.js";
import {
  billingModeWarning, isBillingMode, normalizeBillingEntry, normalizeBillingRange,
  resolveAccountBillingMode, summarizeBillingEntries,
} from "@/shared/utils/accountBilling.js";

const SCOPE = "accountBilling";
const COUNT_FIELDS = ["requests", "inputTokens", "outputTokens", "cachedTokens", "cacheCreationTokens", "totalTokens"];

function readLedger(db, id) {
  const row = db.get("SELECT value FROM kv WHERE scope = ? AND key = ?", [SCOPE, id]);
  if (!row) return null;
  const value = parseJson(row.value, null);
  // Fail closed on corrupt state: never replace a broken ledger with [] on write.
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.entries)) {
    throw new Error("Invalid account billing ledger");
  }
  return value;
}

function writeLedger(db, id, ledger) {
  db.run("INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value", [SCOPE, id, stringifyJson(ledger)]);
}

function readConnectionSnapshot(db, id) {
  const row = db.get("SELECT id, name, email, provider, authType, data FROM providerConnections WHERE id = ?", [id]);
  if (!row) return null;
  const data = parseJson(row.data, {});
  return { id: row.id, name: row.name || data.displayName || row.email || row.id, provider: row.provider, authType: row.authType, billingMode: data.billingMode };
}

function accountSnapshot(connection) {
  return {
    name: connection.name || connection.displayName || connection.email || connection.id,
    provider: connection.provider || null,
    billingMode: resolveAccountBillingMode(connection),
  };
}

function publicBilling(connection, ledger) {
  return {
    mode: connection ? resolveAccountBillingMode(connection) : (ledger?.mode || ledger?.snapshot?.billingMode || "unknown"),
    entries: ledger?.entries || [],
    name: connection ? accountSnapshot(connection).name : ledger?.snapshot?.name,
    provider: connection?.provider || ledger?.snapshot?.provider || null,
    deleted: !connection,
  };
}

export async function getAccountBilling(connectionId) {
  const [db, connection] = await Promise.all([getAdapter(), getProviderConnectionById(connectionId)]);
  const ledger = readLedger(db, connectionId);
  if (!connection && !ledger) return null;
  return publicBilling(connection, ledger);
}

export async function setAccountBillingMode(connectionId, mode) {
  if (!isBillingMode(mode)) throw new Error("Invalid billing mode");
  const db = await getAdapter();
  // Detect broken ledgers before changing the canonical connection setting.
  readLedger(db, connectionId);
  // Use the existing connection writer for the canonical live-account setting.
  // Its transaction preserves arbitrary JSON properties, including billingMode.
  const connection = await updateProviderConnection(connectionId, { billingMode: mode });
  if (!connection) return null;
  let ledger;
  db.transaction(() => {
    const current = readLedger(db, connectionId);
    const latest = readConnectionSnapshot(db, connectionId) || connection;
    ledger = { ...current, mode: resolveAccountBillingMode(latest), snapshot: accountSnapshot(latest), entries: current?.entries || [] };
    writeLedger(db, connectionId, ledger);
  });
  db.flush?.();
  return publicBilling(connection, ledger);
}

export async function appendAccountBillingEntry(connectionId, input) {
  const normalized = normalizeBillingEntry(input);
  const connection = await getProviderConnectionById(connectionId);
  if (!connection) return null;
  const db = await getAdapter();
  let ledger;
  db.transaction(() => {
    // Recheck existence and mode inside the synchronous transaction, so a
    // concurrent PATCH cannot leave the snapshot with the previous mode.
    const latest = readConnectionSnapshot(db, connectionId);
    if (!latest) return;
    const current = readLedger(db, connectionId);
    const entry = { ...normalized, id: normalized.id || randomUUID() };
    const previous = current?.entries.find((item) => item.id === entry.id);
    if (previous) {
      if (JSON.stringify(normalizeBillingEntry(previous)) !== JSON.stringify(normalizeBillingEntry(entry))) {
        const error = new Error("Entry id already exists with different contents");
        error.status = 409;
        throw error;
      }
      ledger = current;
      return;
    }
    ledger = {
      ...current, snapshot: accountSnapshot(latest), mode: resolveAccountBillingMode(latest),
      entries: [...(current?.entries || []), entry],
    };
    writeLedger(db, connectionId, ledger);
  });
  db.flush?.();
  return ledger ? publicBilling(connection, ledger) : null;
}

function emptyCounts() {
  return Object.fromEntries(COUNT_FIELDS.map((key) => [key, 0]));
}

function addCounts(target, source) {
  for (const key of COUNT_FIELDS) target[key] += Number(source[key]) || 0;
}

function addCurrencies(target, source) {
  for (const [currency, amount] of Object.entries(source)) target[currency] = (target[currency] || 0) + amount;
}

// JSON1 is available in all three supported drivers (also used by the existing
// requestDetails expression index). Group in SQLite, not by materializing history.
async function usageGroups(db, start, end, connectionId) {
  const json = "CASE WHEN json_valid(tokens) THEN tokens ELSE '{}' END";
  const token = (...paths) => `MAX(0, COALESCE(${paths.map((path) => `NULLIF(json_extract(${json}, '${path}'), 0)`).join(", ")}, 0))`;
  const input = `MAX(0, COALESCE(NULLIF(json_extract(${json}, '$.prompt_tokens'), 0), NULLIF(json_extract(${json}, '$.input_tokens'), 0), promptTokens, 0))`;
  const output = `MAX(0, COALESCE(NULLIF(json_extract(${json}, '$.completion_tokens'), 0), NULLIF(json_extract(${json}, '$.output_tokens'), 0), completionTokens, 0))`;
  const conditions = ["timestamp >= ?", "timestamp < ?"];
  const params = [start, end];
  if (connectionId !== undefined) { conditions.push("connectionId = ?"); params.push(connectionId); }
  return db.all(`SELECT connectionId, provider, model, date(timestamp) AS date,
    COUNT(*) AS requests, SUM(${input}) AS inputTokens, SUM(${output}) AS outputTokens,
    SUM(${token("$.cached_tokens", "$.cache_read_input_tokens", "$.prompt_tokens_details.cached_tokens")}) AS cachedTokens,
    SUM(${token("$.cache_creation_input_tokens")}) AS cacheCreationTokens,
    SUM(${input} + ${output}) AS totalTokens,
    SUM(CASE WHEN cost >= 0 THEN cost ELSE 0 END) AS referenceEstimate,
    SUM(CASE WHEN (cost IS NULL OR cost <= 0) AND (${input} + ${output}) > 0 THEN 1 ELSE 0 END) AS zeroCostRequests
    FROM usageHistory WHERE ${conditions.join(" AND ")}
    GROUP BY connectionId, provider, model, date(timestamp)`, params);
}

export async function getAccountCosts({ start, end, connectionId } = {}) {
  const range = normalizeBillingRange(start, end);
  const db = await getAdapter();
  const connections = await getProviderConnections();
  const ledgers = new Map(db.all("SELECT key FROM kv WHERE scope = ?", [SCOPE]).map(({ key }) => [key, readLedger(db, key)]));
  const groups = await usageGroups(db, range.start, range.end, connectionId);
  const pricing = groups.length ? await getPricingForModels(groups.map(({ provider, model }) => ({ provider, model }))) : new Map();
  const live = new Map(connections.map((connection) => [connection.id, connection]));
  const accounts = new Map();
  const accountKey = (id, provider) => id ? `id:${id}` : `missing:${provider || "unknown"}`;
  function ensure(id, provider) {
    const key = accountKey(id, provider);
    if (accounts.has(key)) return accounts.get(key);
    const connection = id ? live.get(id) : null;
    const ledger = id ? ledgers.get(id) : null;
    const billing = publicBilling(connection, ledger);
    const billingMode = connection || ledger ? billing.mode : resolveAccountBillingMode({ provider });
    const result = {
      id: id || `unattributed:${provider || "unknown"}`,
      connectionId: id || null,
      name: billing.name || (id ? `Deleted account (${id})` : `Unattributed (${provider || "unknown"})`),
      provider: billing.provider || provider || null, deleted: !connection, billingMode,
      ...emptyCounts(), meteredEstimate: 0, unknownEstimate: 0, unpricedRequests: 0,
      billingWarning: billingModeWarning(billingMode),
      ...summarizeBillingEntries(ledger?.entries || [], range.start, range.end),
      entries: ledger?.entries || [],
      models: [], days: [],
    };
    accounts.set(key, result);
    return result;
  }
  for (const connection of connections) {
    if (connectionId === undefined || connection.id === connectionId) ensure(connection.id, connection.provider);
  }
  for (const [id, ledger] of ledgers) {
    if (connectionId === undefined || id === connectionId) ensure(id, ledger.snapshot?.provider);
  }
  for (const group of groups) {
    const account = ensure(group.connectionId, group.provider);
    addCounts(account, group);
    const reference = Number(group.referenceEstimate) || 0;
    const mode = account.billingMode;
    if (mode === "metered" || mode === "hybrid") account.meteredEstimate += reference;
    else if (mode === "unknown") account.unknownEstimate += reference;
    if (mode === "metered" || mode === "hybrid" || mode === "unknown") {
      // Today's price cannot retroactively give a stored zero an historical
      // price. Flag zero-cost usage unless the model is explicitly free.
      const modelPricing = pricing.get(`${group.provider || ""}/${group.model}`);
      const explicitlyFree = modelPricing && modelPricing.input === 0 && modelPricing.output === 0 &&
        [modelPricing.cached, modelPricing.cache_creation, modelPricing.reasoning].every((rate) => rate == null || rate === 0);
      if (!explicitlyFree) account.unpricedRequests += Number(group.zeroCostRequests) || 0;
    }
    for (const [list, field, value] of [[account.models, "model", group.model || "unknown"], [account.days, "date", group.date]]) {
      let item = list.find((row) => row[field] === value);
      if (!item) { item = { [field]: value, ...emptyCounts() }; list.push(item); }
      addCounts(item, group);
    }
  }
  const totals = { ...emptyCounts(), meteredEstimate: 0, unknownEstimate: 0, unpricedRequests: 0, subscriptionPaid: {}, subscriptionAccrued: {} };
  for (const account of accounts.values()) {
    addCounts(totals, account);
    totals.meteredEstimate += account.meteredEstimate;
    totals.unknownEstimate += account.unknownEstimate;
    totals.unpricedRequests += account.unpricedRequests;
    addCurrencies(totals.subscriptionPaid, account.subscriptionPaid);
    addCurrencies(totals.subscriptionAccrued, account.subscriptionAccrued);
    account.models.sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model));
    account.days.sort((a, b) => a.date.localeCompare(b.date));
  }
  return { ...range, dayTimezone: "UTC", accounts: [...accounts.values()], totals };
}
