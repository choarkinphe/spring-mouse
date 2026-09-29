import { NextResponse } from "next/server";
import { getCombos } from "@/lib/localDb";
import { getActiveComboModels } from "open-sse/services/combo.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Return only combos that can currently serve a Claude Messages default route.
 * The dashboard picker intentionally uses the same active-member rule as the
 * public model list, but does not apply API-key access tags because this is an
 * instance-wide setting rather than a request-specific model list.
 */
export async function GET() {
  try {
    const combos = await getCombos();
    const now = new Date();
    const available = combos
      .filter((combo) => {
        if (combo?.isActive === false) return false;
        if (combo?.kind && combo.kind !== "llm") return false;
        if (!Array.isArray(combo?.models) || combo.models.length === 0) return false;
        const activeModels = getActiveComboModels(combo.models, now);
        return Array.isArray(activeModels) && activeModels.length > 0;
      })
      .map((combo) => ({
        name: combo.name,
        groupName: combo.groupName || null,
        activeModelCount: getActiveComboModels(combo.models, now)?.length || 0,
      }));

    return NextResponse.json({ combos: available }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.log("Error fetching Claude Messages combos:", error);
    return NextResponse.json({ error: "Failed to fetch Claude Messages combos" }, { status: 500 });
  }
}
