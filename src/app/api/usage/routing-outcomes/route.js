import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { getRoutingOutcomes } from "@/lib/db/repos/routingTelemetryRepo.js";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
};

function json(body, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

function truthyParameter(value) {
  return value === "true" || value === "1";
}

/**
 * Routing telemetry is a dashboard-only view. It intentionally does not accept
 * a scope or API-key filter: telemetry is not billing data and exposing a
 * caller-controlled scope would make it possible to bypass the dashboard
 * session guard.
 */
export async function GET(request) {
  try {
    const cookieStore = await cookies();
    const session = await getDashboardAuthSession(cookieStore.get("auth_token")?.value);
    if (session?.authenticated !== true) {
      return json({ error: "Authentication required" }, 401);
    }

    const url = new URL(request?.url || "http://localhost/api/usage/routing-outcomes");
    const range = {
      startDate: url.searchParams.get("startDate") || undefined,
      endDate: url.searchParams.get("endDate") || undefined,
    };
    const result = await getRoutingOutcomes(range);

    // Health is process-local and optional. It is included only when callers
    // explicitly opt in to both flags, so the default response remains a pure
    // persisted telemetry report and never implies fleet-wide health.
    if (truthyParameter(url.searchParams.get("processLocal"))
      && truthyParameter(url.searchParams.get("bestEffort"))) {
      try {
        const routingEvents = await import("@/lib/redis/routingEvents.js");
        if (typeof routingEvents.getRoutingTelemetryHealth === "function") {
          result.health = await routingEvents.getRoutingTelemetryHealth();
          result.healthScope = "process-local";
        }
      } catch {
        // Optional Redis health must not turn a healthy persisted report into a
        // server error when Redis support is disabled or not installed.
      }
    }

    return json(result, 200);
  } catch (error) {
    if (error instanceof RangeError) return json({ error: error.message }, 400);
    console.error("[API] Failed to get routing outcomes:", error);
    return json({ error: "Failed to fetch routing outcomes" }, 500);
  }
}
