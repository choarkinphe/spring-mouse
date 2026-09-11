import { NextResponse } from "next/server";
import { getProviderConnections } from "@/models";
import { getSettings } from "@/lib/localDb";
import { getConnectionConcurrencyLimit, getConnectionSlotCounts } from "@/lib/redis/connectionSlots";
import { PROVIDERS } from "open-sse/config/providers.js";

export const dynamic = "force-dynamic";

// Mirrors the `accountStrategy` resolution in src/sse/services/auth.js so the
// reported ceiling is the one admission actually enforces (a provider-level
// transport default applies when the channel strategy leaves it unset).
function accountLimit(connection, providerOverride = {}) {
  const transport = PROVIDERS[connection.provider]?.transport || {};
  const accountStrategy = providerOverride.maxConcurrentStreams == null && Number.isFinite(transport.maxConcurrentStreams)
    ? { ...providerOverride, maxConcurrentStreams: transport.maxConcurrentStreams }
    : providerOverride;
  return getConnectionConcurrencyLimit(connection, accountStrategy);
}

// GET /api/providers/concurrency - live per-account concurrency usage.
//
// The router admits every upstream request through an in-process lease before
// it reaches a provider (see lib/redis/connectionSlots.js), so these are the
// same numbers admission itself uses rather than a separately tracked
// approximation. Kept as its own route so the channel list can poll it
// cheaply without re-reading connections, quotas and model counts every tick.
export async function GET() {
  try {
    const [connections, settings] = await Promise.all([getProviderConnections(), getSettings()]);
    const counts = getConnectionSlotCounts();
    const strategies = settings?.providerStrategies || {};

    const accounts = {};
    for (const connection of connections) {
      accounts[connection.id] = {
        active: counts[connection.id] || 0,
        limit: accountLimit(connection, strategies[connection.provider] || {}),
      };
    }

    return NextResponse.json({ accounts }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.log("Error reading connection concurrency:", error);
    return NextResponse.json({ error: "Failed to read connection concurrency" }, { status: 500 });
  }
}
