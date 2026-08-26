import { NextResponse } from "next/server";
import { getRedisHealth } from "@/lib/redis/client.js";
import { getUsageQueueHealth } from "@/lib/redis/liveUsage.js";

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
  const ok = (!redisRequired || redis.connected)
    && (!redisRequired || usageQueue.writerHealthy !== false);
  return NextResponse.json({ ok, redisRequired, redis, usageQueue }, { status: ok ? 200 : 503, headers: CORS_HEADERS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
