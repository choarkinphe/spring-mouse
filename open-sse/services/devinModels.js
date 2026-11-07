import { createHash } from "node:crypto";
import { DEVIN } from "../config/devin.js";
import { decodeProtobuf, encodeBytesField } from "../shared/devin/protobuf.js";
import { buildDevinClientMetadata, normalizeDevinSessionToken } from "../shared/devin/protocol.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

// Schema and family selection adapted from magpie-community/plugins (MIT),
// packages/devin at 749e9dd12a5401cc11a701b7598c7ce32fcd7259.
export const DEVIN_MODELS_PATH = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const CATALOG_TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 300000;
const MAX_CACHED_ACCOUNTS = 100;
const catalogs = new Map();
const LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const TIERS = ["fast", "priority", "lightning"];
export const normalizeDevinToken = normalizeDevinSessionToken;
const text = (fields, number) => fields.find(f => f.number === number && f.wireType === 2)?.value.toString("utf8").trim();
const integer = (fields, number) => Number(fields.find(f => f.number === number && f.wireType === 0)?.value ?? 0n);

export function devinVariantLevel(id) {
  const match = String(id).match(/[-_](none|minimal|low|medium|high|xhigh|max|thinking)(?:[-_](fast|priority|lightning))?$/i);
  return { effort: match?.[1]?.toLowerCase().replace("thinking", "high") || "", tier: match?.[2]?.toLowerCase() || "" };
}
export function parseDevinModels(payload) {
  const models = [];
  const seen = new Set();
  for (const field of decodeProtobuf(payload, { maxBytes: MAX_CATALOG_BYTES })) {
    if (field.number !== 1 || field.wireType !== 2) continue;
    const fields = decodeProtobuf(field.value, { maxBytes: MAX_CATALOG_BYTES });
    const id = text(fields, 22);
    if (!id || id.length > 512 || /[\x00-\x20\x7f]/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const model = { id, name: text(fields, 1) || id, isVL: integer(fields, 5) !== 0 };
    const contextLength = integer(fields, 18);
    if (Number.isSafeInteger(contextLength) && contextLength > 0) model.contextLength = contextLength;
    const info = fields.find(f => f.number === 23 && f.wireType === 2);
    if (info) {
      const nested = decodeProtobuf(info.value);
      const familyUid = text(nested, 23);
      const output = integer(nested, 13);
      if (familyUid) model.familyUid = familyUid;
      if (output > 0) model.maxOutputTokens = output;
    }
    const metadata = fields.find(f => f.number === 30 && f.wireType === 2);
    if (metadata) model.familyLabel = text(decodeProtobuf(metadata.value), 1) || model.name;
    if (integer(fields, 24) === 4) model.isFree = true;
    const cost = {};
    for (const price of fields.filter(f => f.number === 32 && f.wireType === 2)) {
      const p = decodeProtobuf(price.value);
      const key = { Input: "input", "Cached input": "cacheRead", Output: "output" }[text(p, 1)];
      const amount = p.find(f => f.number === 2 && f.wireType === 5)?.value.readFloatLE(0);
      if (key && text(p, 3) === "1M tokens" && Number.isFinite(amount) && amount >= 0) cost[key] = +amount.toPrecision(6);
    }
    if (model.isFree) model.cost = { input: 0, output: 0, cacheRead: 0 };
    else if (cost.input > 0 || cost.output > 0) model.cost = cost;
    model.capabilities = {
      vision: model.isVL, tools: true,
      ...(model.contextLength ? { contextWindow: model.contextLength } : {}),
      ...(model.maxOutputTokens ? { maxOutput: model.maxOutputTokens } : {}),
    };
    if (!/^(adaptive|fusion)$/i.test(model.familyUid || id)) models.push(model);
  }
  return models;
}

export function listDevinModelFamilies(variants) {
  const families = new Map();
  for (const variant of variants) {
    // The wire family is authoritative. A missing family does not justify
    // inventing one from labels or a model-name regex.
    const family = variant.familyUid || variant.id;
    if (!families.has(family)) families.set(family, []);
    families.get(family).push(variant);
  }
  const out = [];
  for (const [family, members] of families) {
    const base = members[0];
    const add = (id, name, selection) => {
      if (!selection.length) return;
      const levels = LEVELS.filter(level => selection.some(m => devinVariantLevel(m.id).effort === level));
      const entry = { id, name, contextLength: base.contextLength, maxOutputTokens: base.maxOutputTokens,
        isReasoning: levels.length > 0, ...(levels.length ? { thinkingLevels: levels } : {}),
        variants: selection.map(m => ({ id: m.id, effort: devinVariantLevel(m.id).effort })) };
      const image = selection[0].isVL;
      if (selection.every(m => m.isVL === image)) entry.isVL = image;
      if (selection.every(m => m.isFree)) entry.isFree = true;
      if (selection[0].cost && selection.every(m => JSON.stringify(m.cost) === JSON.stringify(selection[0].cost))) entry.cost = selection[0].cost;
      entry.capabilities = { tools: true, reasoning: levels.length > 0,
        ...(typeof entry.isVL === "boolean" ? { vision: entry.isVL } : {}),
        ...(entry.contextLength ? { contextWindow: entry.contextLength } : {}),
        ...(entry.maxOutputTokens ? { maxOutput: entry.maxOutputTokens } : {}),
      };
      out.push(entry);
    };
    const normal = members.filter(m => !devinVariantLevel(m.id).tier && !/[-_](lightning|fast|priority)$/.test(m.id));
    add(family, base.familyLabel || base.name, normal.length ? normal : members);
    for (const tier of TIERS) {
      if (families.has(`${family}-${tier}`)) continue;
      add(`${family}-${tier}`, `${base.familyLabel || base.name} ${tier}`, members.filter(m => devinVariantLevel(m.id).tier === tier));
    }
    // Explicit variants remain addressable, including nonstandard variants.
    for (const member of members) if (!out.some(m => m.id === member.id)) out.push(member);
  }
  return out;
}

async function readCatalog(body) {
  if (!body) throw new Error("Devin returned an empty model directory");
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_CATALOG_BYTES) throw new Error("Devin model directory exceeds size limit");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function resolveDevinModels(credentials, { fetchFn = proxyAwareFetch, proxyOptions = null, signal, useCache = false } = {}) {
  const token = normalizeDevinToken(credentials?.accessToken || credentials?.apiKey);
  if (!token) return { models: [], error: "Devin access token is missing", status: 401 };
  const key = createHash("sha256").update(token).digest("hex");
  const cached = catalogs.get(key);
  if (useCache && cached?.until > Date.now()) return structuredClone(cached.result);
  const body = encodeBytesField(1, buildDevinClientMetadata({ sessionToken: token }));
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(CATALOG_TIMEOUT_MS)]) : AbortSignal.timeout(CATALOG_TIMEOUT_MS);
  try {
    // As in the native CLI, unary catalog credentials live in metadata.
    const response = await fetchFn(`${DEVIN.baseUrl}${DEVIN_MODELS_PATH}`, {
      method: "POST", headers: { "Content-Type": "application/proto", "Connect-Protocol-Version": "1" },
      body, signal: requestSignal, redirect: "error",
    }, proxyOptions);
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if ([401, 403].includes(response.status)) catalogs.delete(key);
      return { models: [], error: `Devin model discovery failed (HTTP ${response.status})`, status: response.status };
    }
    const variants = parseDevinModels(await readCatalog(response.body));
    if (!variants.length) return { models: [], error: "Devin returned no selectable models", status: 502 };
    const result = { models: listDevinModelFamilies(variants), variants, listingScope: "account" };
    catalogs.delete(key);
    catalogs.set(key, { until: Date.now() + CACHE_TTL_MS, result });
    if (catalogs.size > MAX_CACHED_ACCOUNTS) catalogs.delete(catalogs.keys().next().value);
    return structuredClone(result);
  } catch {
    return { models: [], error: requestSignal.aborted ? "Devin model discovery timed out or was cancelled" : "Devin returned an invalid or unavailable model directory", status: requestSignal.aborted ? 504 : 502 };
  }
}

export async function resolveDevinModel({ credentials, model, effort, proxyOptions, signal }) {
  const id = String(model || "").replace(/^(devin|dvn)\//, "");
  // An explicit official variant is already a fully specified wire model.
  if (devinVariantLevel(id).effort) return id;
  const directory = await resolveDevinModels(credentials, { proxyOptions, signal, useCache: true });
  if (directory.error) {
    const error = new Error(directory.error); error.status = directory.status; error.code = "devin_model_directory_error"; throw error;
  }
  const family = directory.models.find(m => m.id === id && m.variants?.length);
  if (!family) return id;
  const variants = family.variants;
  if (effort && LEVELS.includes(effort)) {
    const exact = variants.find(v => v.effort === effort);
    if (exact) return exact.id;
    const wanted = LEVELS.indexOf(effort);
    const available = variants.filter(v => LEVELS.includes(v.effort)).sort((a, b) => {
      const ai = LEVELS.indexOf(a.effort), bi = LEVELS.indexOf(b.effort);
      return Math.abs(ai - wanted) - Math.abs(bi - wanted) || bi - ai;
    });
    if (available.length) return available[0].id;
  }
  return variants[0].id;
}
