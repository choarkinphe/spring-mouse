/**
 * Group templates: a routing group for a common need, built from the operator's
 * own models in one click.
 *
 * Pure and dependency-free so the dashboard can also import it to explain why a
 * template cannot be built (missing a second provider, missing a cheap model)
 * without a second copy of the rules. The members it picks are ordinary combo
 * nodes — a template creates a normal combo, it is not a special combo kind.
 *
 * Kinds mirror what the presets are for, not how they are implemented:
 *   smart   hard turns to the strongest model, easy ones and compaction to a cheap one
 *   thrifty a cheap model first; the strongest for high reasoning or when the cheap ones fail
 *   steady  the strongest model of each of up to three providers, each behind the other
 */

export const TEMPLATE_KINDS = Object.freeze(["smart", "thrifty", "steady"]);

// Tiers are ordering hints for auto routing, not claims about a model: the
// dashboard keeps the same three labels, so a template's output is legible
// there. Only a non-default tier is ever written (see buildTemplateMembers).
export const TEMPLATE_TIERS = Object.freeze({ SMART: "strong", CHEAP: "fast" });

const TEMPLATE_LABELS = Object.freeze({
  smart: { name: "难题给强模型，简单的给便宜模型", summary: "难的交给最强的模型，简单的任务和压缩交给便宜模型" },
  thrifty: { name: "便宜优先", summary: "先用便宜模型；需要高推理或便宜模型都失败时，交给最强的" },
  steady: { name: "永不卡住", summary: "每家供应商各取最强的一个，依次后备，一家挂了照样能用" },
});

export function getTemplateLabel(kind) {
  return TEMPLATE_LABELS[kind] || null;
}

/**
 * Blended per-1K cost, or null when the model has no usable price.
 *
 * Zero is a REAL price (a free model), not a missing one. Collapsing it into
 * null made free models sort as "unknown", i.e. most expensive, which is the
 * opposite of what a cost-aware template wants.
 */
function priceOf(entry) {
  const pricing = entry?.pricing || {};
  const hasInput = pricing.input !== null && pricing.input !== undefined && Number.isFinite(Number(pricing.input));
  const hasOutput = pricing.output !== null && pricing.output !== undefined && Number.isFinite(Number(pricing.output));
  if (!hasInput && !hasOutput) return null;
  // Blended cost: roughly one output token per three input tokens for chat work.
  const blend = (hasInput ? Number(pricing.input) : 0) + (hasOutput ? Number(pricing.output) : 0) / 3;
  return blend >= 0 ? blend : null;
}

function isFree(entry) {
  return priceOf(entry) === 0;
}

/**
 * Rank models strongest-first.
 *
 * There is no trustworthy cross-vendor "strength" number here, so the ordering
 * has to come from signals that are actually present: reasoning support first
 * (a model that cannot reason is a poor "strongest"), then a larger context
 * window, then name heuristics for the vendor tiers everyone recognises. Price
 * is only a last tiebreaker, high first — a cheap model is not a stronger one.
 */
export function strengthScore(entry) {
  const caps = entry?.caps || {};
  const name = String(entry?.model || "").toLowerCase();
  let score = 0;
  if (caps.reasoning === true) score += 100;
  if (caps.tools === true) score += 10;
  const context = Number(caps.contextWindow);
  if (Number.isFinite(context) && context > 0) score += Math.min(40, Math.log2(context / 1000));
  // Recognised top tiers across the vendors in this repo.
  if (/(opus|gpt-5\.6|gpt-6|sol|o3|o4|sonnet|pro|max|ultra)/.test(name)) score += 35;
  if (/(haiku|flash|mini|lite|fast|turbo|small|nano)/.test(name)) score -= 30;
  return score;
}

/**
 * Cheapest-first ordering key. Entries without pricing sort LAST: an unknown
 * cost must never be mistaken for a low one. Free models score 0 and win.
 */
export function cheapnessScore(entry) {
  const price = priceOf(entry);
  return price === null ? Number.POSITIVE_INFINITY : price;
}

function byStrength(a, b) {
  const diff = strengthScore(b) - strengthScore(a);
  if (diff !== 0) return diff;
  const pa = priceOf(a);
  const pb = priceOf(b);
  // Among equals, the dearer one is usually the bigger model.
  return (pb ?? -1) - (pa ?? -1);
}

function byCheapness(a, b) {
  const pa = cheapnessScore(a);
  const pb = cheapnessScore(b);
  // Unknown cost is not "cheap": both infinities tie, one infinity loses.
  if (pa !== pb) return pa < pb ? -1 : 1;
  return byStrength(a, b);
}

const idOf = (entry) => entry?.fullModel || (entry?.provider && entry?.model ? `${entry.provider}/${entry.model}` : "");

/**
 * Drop entries a combo cannot use: no id, or an already-chosen id.
 * `seen` is mutated so callers can chain picks without duplicates.
 */
function takeUnique(list, count, seen) {
  const out = [];
  for (const entry of list) {
    if (out.length >= count) break;
    const id = idOf(entry);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(entry);
  }
  return out;
}

/**
 * Build a template's members.
 *
 * @param {string} kind - One of TEMPLATE_KINDS.
 * @param {Array<object>} models - Model entries from /api/models ({provider, model, fullModel, caps, pricing}).
 * @returns {{ members: Array<{model: string, autoTier?: string}>, need: string|null, of?: string }}
 *   `members` is empty when the template cannot be built; `need` says why in a
 *   key the dashboard translates ("providers", "cheap", "any").
 */
export function buildTemplateMembers(kind, models) {
  const usable = (Array.isArray(models) ? models : [])
    // Routing groups hold conversational models; a voice or image model in a
    // chat group would only ever fail over into another failure.
    .filter((entry) => entry && entry.model && idOf(entry) && entry.kind !== "webSearch" && entry.kind !== "webFetch")
    .filter((entry) => entry.caps?.imageOutput !== true && entry.caps?.audioOutput !== true);

  if (usable.length === 0) return { members: [], need: "any" };

  const strongestFirst = [...usable].sort(byStrength);
  const cheapestFirst = [...usable].sort(byCheapness);
  const strongest = strongestFirst[0];
  const seen = new Set();

  if (kind === "steady") {
    // One strongest model per provider, in strength order: a provider-wide
    // outage then costs one member, not the whole group.
    const chosen = [];
    const usedProviders = new Set();
    for (const entry of strongestFirst) {
      if (chosen.length >= 3) break;
      if (usedProviders.has(entry.provider)) continue;
      usedProviders.add(entry.provider);
      chosen.push(entry);
    }
    if (chosen.length < 2) {
      return { members: [], need: "providers", of: strongest?.provider || "" };
    }
    return {
      // No tier: "balanced" is the default, and writing it would store a field
      // that says nothing. Steady is about provider spread, not difficulty.
      members: chosen.map((entry) => ({ model: idOf(entry) })),
      need: null,
    };
  }

  if (kind === "thrifty") {
    const [cheap] = takeUnique(cheapestFirst, 1, seen);
    if (!cheap) return { members: [], need: "any" };
    // The fallback exists to be BETTER than the cheap pick, so it must be a
    // dearer reasoning model. Otherwise the second member only repeats the
    // first and the combo is just the cheap model with extra steps.
    const cheapPrice = cheapnessScore(cheap);
    const rush = takeUnique(
      strongestFirst.filter((entry) => entry.caps?.reasoning === true && cheapnessScore(entry) > cheapPrice),
      1,
      seen,
    );
    const members = [
      { model: idOf(cheap), autoTier: TEMPLATE_TIERS.CHEAP },
      ...rush.map((entry) => ({ model: idOf(entry), autoTier: TEMPLATE_TIERS.SMART })),
    ];
    return { members, need: null };
  }

  // smart: strongest for hard turns, a cheap one for easy turns and compaction.
  //
  // "Cheap" has to mean cheaper than the strong pick, or the second member is
  // only a duplicate of the first at the same price — the operator gets a
  // two-node combo with none of the savings the template promises.
  const [strong] = takeUnique(strongestFirst, 1, seen);
  if (!strong) return { members: [], need: "any" };
  const strongPrice = cheapnessScore(strong);
  const [cheap] = takeUnique(
    cheapestFirst.filter((entry) => cheapnessScore(entry) < strongPrice),
    1,
    seen,
  );
  if (!cheap) {
    return { members: [], need: "cheap", of: idOf(strong) };
  }
  return {
    members: [
      { model: idOf(strong), autoTier: TEMPLATE_TIERS.SMART },
      { model: idOf(cheap), autoTier: TEMPLATE_TIERS.CHEAP },
    ],
    need: null,
  };
}

/** A name that does not collide with an existing combo. */
export function templateComboName(kind, existingNames = []) {
  const base = `tpl-${kind}`;
  const taken = new Set(existingNames);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}
