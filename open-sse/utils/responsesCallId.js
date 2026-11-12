import { createHash } from "node:crypto";
import { RESPONSES_CALL_ID } from "../config/responsesApi.js";

/**
 * Shorten only oversized Responses call_id values, never item IDs or payloads.
 * The same original ID always maps to the same replacement for both calls and
 * results. Hash the entire ID so distinct suffixes aren't lost by truncation.
 * Reserve compliant IDs first: an existing ID must never be merged with a
 * generated replacement, even if a client deliberately uses our hash spelling.
 */
export function normalizeResponsesCallIds(body) {
  if (!Array.isArray(body?.input)) return body;
  const ids = body.input.map((item) => item?.call_id).filter((id) => typeof id === "string");
  const occupied = new Set(ids.filter((id) => id.length <= RESPONSES_CALL_ID.maxLength));
  const replacements = new Map();
  for (const id of [...new Set(ids)].filter((id) => id.length > RESPONSES_CALL_ID.maxLength).sort()) {
    let candidate;
    let salt = 0;
    do {
      const digest = createHash("sha256").update(salt ? `${salt}:${id}` : id).digest("base64url");
      candidate = `${RESPONSES_CALL_ID.replacementPrefix}${digest}`;
      salt += 1;
    } while (occupied.has(candidate));
    occupied.add(candidate);
    replacements.set(id, candidate);
  }
  for (const item of body.input) {
    if (replacements.has(item?.call_id)) item.call_id = replacements.get(item.call_id);
  }
  return body;
}
