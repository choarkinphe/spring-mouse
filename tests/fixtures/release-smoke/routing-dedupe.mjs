import assert from "node:assert/strict";
import { createClient } from "redis";
import { ROUTING_APPEND_SCRIPT, ROUTING_STREAM_KEY } from "/fixture/src/lib/redis/routingEvents.js";

const client = createClient({ url: process.env.SPRING_MOUSE_REDIS_URL || "redis://127.0.0.1:6379", socket: { reconnectStrategy: false } });
client.on("error", () => {});
const stream = `${ROUTING_STREAM_KEY}:smoke-dedupe`;
const token = `${stream}:token`;
try {
  await client.connect();
  const options = { keys: [stream, token], arguments: [JSON.stringify({ fixture: true })] };
  const ids = await Promise.all(Array.from({ length: 20 }, () => client.eval(ROUTING_APPEND_SCRIPT, options)));
  assert.equal(new Set(ids).size, 1, "concurrent delivery retries duplicated the event");
  assert.equal(await client.xLen(stream), 1);
  await client.xDel(stream, ids[0]);
  assert.equal(await client.eval(ROUTING_APPEND_SCRIPT, options), ids[0]);
  assert.equal(await client.xLen(stream), 0, "retry reinserted an already consumed event");
  const ttl = await client.pTTL(token);
  assert.ok(ttl > 10000 && ttl <= 60000, "dedupe token must outlive the retry window");
  console.log(JSON.stringify({ check: "routing-dedupe", concurrentRetries: 20, passed: true }));
} finally {
  if (client.isOpen) {
    await client.del([stream, token]);
    await client.quit();
  }
}
