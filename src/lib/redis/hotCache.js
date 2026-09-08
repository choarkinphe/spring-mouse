import { getRedisClient } from "./client.js";

const PREFIX = "spring-mouse:hot:v1:";
const DEFAULT_TTL_SECONDS = 60;

function fullKey(key) {
  return `${PREFIX}${key}`;
}

export async function getHotJson(key) {
  try {
    const client = await getRedisClient({ required: false });
    if (!client) return null;
    const value = await client.get(fullKey(key));
    if (!value) return null;
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function setHotJson(key, value, ttlSeconds = DEFAULT_TTL_SECONDS) {
  try {
    const client = await getRedisClient({ required: false });
    if (!client) return false;
    await client.set(fullKey(key), JSON.stringify(value), {
      EX: Math.max(1, Math.floor(Number(ttlSeconds) || DEFAULT_TTL_SECONDS)),
    });
    return true;
  } catch {
    return false;
  }
}

export async function deleteHotJson(key) {
  try {
    const client = await getRedisClient({ required: false });
    if (!client) return false;
    await client.del(fullKey(key));
    return true;
  } catch {
    return false;
  }
}

export async function incrementHotCounter(key, ttlSeconds = 120) {
  try {
    const client = await getRedisClient({ required: false });
    if (!client) return null;
    const value = await client.incr(fullKey(key));
    if (value === 1) {
      await client.expire(fullKey(key), Math.max(1, Math.floor(Number(ttlSeconds) || 120)));
    }
    return Number(value);
  } catch {
    return null;
  }
}
