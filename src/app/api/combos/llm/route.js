import { NextResponse } from "next/server";
import { getCombos } from "@/lib/localDb";
import { getActiveComboModels } from "open-sse/services/combo.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Structural reasons a combo can never be a routing target, regardless of the
 * clock: it is disabled, is not an LLM combo, or has no members. These are
 * filtered out in both modes, because `PATCH /api/settings` rejects them — a
 * picker must not offer a choice the save will refuse.
 */
function isStructurallyUnusable(combo) {
  if (!combo || !combo.name) return true;
  if (combo.isActive === false) return true;
  if (combo.kind && combo.kind !== "llm") return true;
  if (!Array.isArray(combo.models) || combo.models.length === 0) return true;
  return false;
}

/**
 * Why a combo cannot serve a request *right now*. Only the schedule is left:
 * every structural reason is filtered before this is consulted, so a non-null
 * result always means "in a schedule gap" — which the dashboard annotates
 * rather than hides, because a mapping is durable config.
 */
function scheduleGapReason(activeModels) {
  if (!Array.isArray(activeModels) || activeModels.length === 0) return "scheduled-out";
  return null;
}

/**
 * Return LLM combos for the dashboard pickers.
 *
 * Default (`?includeUnavailable` absent/false): only combos that can serve right
 * now, which is the rule the public model list uses. The legacy Claude Messages
 * picker relies on this, so the default must not change.
 *
 * `?includeUnavailable=1`: additionally includes combos that are merely in a
 * schedule gap, each annotated with `available` and (when false)
 * `unavailableReason`. The Harness page uses this because a mapping is durable
 * config — a combo that is dark at 18:42 is precisely what the operator means
 * to map for 09:00, and hiding it makes that impossible to express.
 * Structurally-unusable combos are filtered in both modes. Access tags are not
 * applied either way: this is an instance-wide setting rather than a
 * request-specific model list.
 */
export async function GET(request) {
  try {
    const combos = await getCombos();
    const now = new Date();
    const includeUnavailable = (() => {
      if (!request?.url) return false;
      try {
        const value = new URL(request.url).searchParams.get("includeUnavailable");
        return value === "1" || value === "true";
      } catch {
        return false;
      }
    })();

    const described = combos
      .filter((combo) => !isStructurallyUnusable(combo))
      .map((combo) => {
        const activeModels = getActiveComboModels(combo.models, now);
        const reason = scheduleGapReason(activeModels);
        return {
          name: combo.name,
          groupName: combo.groupName || null,
          activeModelCount: Array.isArray(activeModels) ? activeModels.length : 0,
          available: reason === null,
          unavailableReason: reason,
        };
      });

    const available = includeUnavailable
      ? described
      : described.filter((combo) => combo.available);

    return NextResponse.json({ combos: available }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.log("Error fetching Claude Messages combos:", error);
    return NextResponse.json({ error: "Failed to fetch Claude Messages combos" }, { status: 500 });
  }
}
