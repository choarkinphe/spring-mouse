import { createHash } from "node:crypto";
import { routingRedis } from "./routingClient.js";

const PREFIX = "spring-mouse:routing:sticky:v1:";
const DEFAULT_TTL_SECONDS = 6 * 60 * 60;
const TTL_SECONDS = Math.max(60, Number.parseInt(process.env.SPRING_MOUSE_STICKY_TTL_SECONDS, 10) || DEFAULT_TTL_SECONDS);

// Atomically read/claim/replace one requester assignment. An expected value of
// "" means claim only when no assignment exists; a non-empty expected value
// replaces the assignment only if it is still current. This keeps multiple
// workers from blindly overwriting each other's sticky account choice.
const ASSIGN_SCRIPT = `
local current = redis.call('GET', KEYS[1])
local expected = ARGV[1]
local next = ARGV[2]
local ttl = tonumber(ARGV[3])
if expected == '' then
  if current then return current end
  redis.call('SET', KEYS[1], next, 'EX', ttl, 'NX')
  return redis.call('GET', KEYS[1]) or ''
end
if current == expected then
  redis.call('SET', KEYS[1], next, 'EX', ttl)
  return next
end
return current or ''
`;

function keyFor(providerId, requesterId) {
  const provider = String(providerId || "");
  const requester = String(requesterId || "");
  const digest = createHash("sha256").update(requester).digest("hex");
  return `${PREFIX}${provider}:${digest}`;
}

export async function getStickyAssignment(providerId, requesterId) {
  if (!providerId || !requesterId) return null;
  const value = await routingRedis((client) => client.get(keyFor(providerId, requesterId)));
  return typeof value === "string" && value ? value : null;
}

/**
 * Claim an assignment when expected is null, or replace it only when the
 * current Redis value still equals expected. Returns null when Redis is
 * unavailable and an empty string when the key is absent.
 */
export async function claimStickyAssignment(providerId, requesterId, nextConnectionId, expected = null) {
  if (!providerId || !requesterId || !nextConnectionId) return null;
  const value = await routingRedis((client) => client.eval(ASSIGN_SCRIPT, {
    keys: [keyFor(providerId, requesterId)],
    arguments: [expected || "", String(nextConnectionId), String(TTL_SECONDS)],
  }));
  if (value === null || value === undefined) return null;
  return String(value) || null;
}
