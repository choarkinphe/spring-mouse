import { NextResponse } from "next/server";
import { getRedisHealth } from "@/lib/redis/client.js";
import { getUsageQueueHealth } from "@/lib/redis/liveUsage.js";
import { getUsageAggregatePoolStatus } from "@/lib/db/usageAggregatePool.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export async function GET() {
  const [redis, usageQueue] = await Promise.all([
    getRedisHealth(),
    getUsageQueueHealth().catch((error) => ({ configured: true, error: error.message })),
  ]);
  const redisRequired = process.env.SPRING_MOUSE_REDIS_REQUIRED === "true";
  // Aggregation health is informational: the pool fails open to an in-process
  // scan, so a degraded pool slows the dashboard but never breaks routing.
  const usageAggregate = getUsageAggregatePoolStatus();
  const ok = (!redisRequired || redis.connected)
    && (!redisRequired || usageQueue.writerHealthy !== false);
  return NextResponse.json({ ok, redisRequired, redis, usageQueue, usageAggregate }, { status: ok ? 200 : 503, headers: CORS_HEADERS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
