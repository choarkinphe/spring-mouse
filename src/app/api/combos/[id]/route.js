import { normalizeComboSearch, getComboSearchValidationError } from "open-sse/services/comboSearch.js";
import { NextResponse } from "next/server";
import { normalizeComboModelsForStorage, normalizeComboCapabilities, getComboCapabilityValidationError, resetComboRotation } from "open-sse/services/combo.js";
import { resetComboRotationCount } from "@/lib/redis/comboRotation.js";
import { getComboById, updateCombo, deleteCombo, getComboByName, getCombos, getSettings, updateSettings } from "@/lib/localDb";
import { refreshModelCapabilityOverrides } from "@/lib/modelCapabilityOverrides";
import { normalizeAccessTags } from "@/shared/utils/accessTags";

// Validate combo name: only a-z, A-Z, 0-9, -, _
const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

const MAX_GROUP_NAME_LENGTH = 64;
const MAX_SORT_ORDER = 1_000_000;

function validateComboOrganization({ groupName, sortOrder }) {
  if (groupName !== undefined && groupName !== null && (typeof groupName !== "string" || groupName.trim().length > MAX_GROUP_NAME_LENGTH)) {
    return "Group name must be a string of 64 characters or fewer";
  }
  if (sortOrder !== undefined && (!Number.isInteger(sortOrder) || Math.abs(sortOrder) > MAX_SORT_ORDER)) {
    return "Sort order must be an integer between -1000000 and 1000000";
  }
  return null;
}

/**
 * Move a strategy stored under the combo's old NAME onto its id.
 *
 * Settings written before migration 026 key strategies by name. Migration 026
 * rewrites those, but a combo renamed *after* the migration could still be
 * carrying a name key if its row was created by an older build, so the rename
 * path fixes it directly. Fail-open: a settings write failure must not fail the
 * rename itself.
 */
/**
 * Drop a deleted combo's strategy, by id and by its old name key.
 *
 * Leaving it behind is not merely clutter: a later combo created with the same
 * name would inherit the deleted one's fusion judge or classifier, so the new
 * route would behave like a combo the operator never configured.
 */
async function dropComboStrategy(comboId, comboName) {
  try {
    const settings = await getSettings();
    const strategies = settings.comboStrategies;
    if (!strategies || typeof strategies !== "object" || Array.isArray(strategies)) return;
    const next = { ...strategies };
    let changed = false;
    for (const key of [comboId, comboName]) {
      if (!key || !Object.hasOwn(next, key)) continue;
      delete next[key];
      changed = true;
    }
    if (changed) await updateSettings({ comboStrategies: next });
  } catch (error) {
    console.warn(`[combos] strategy cleanup for ${comboId} skipped:`, error.message);
  }
}

async function migrateLegacyStrategyKey(combo, previousName) {
  if (!combo?.id || !previousName || previousName === combo.id) return;
  try {
    const settings = await getSettings();
    const strategies = settings.comboStrategies;
    if (!strategies || typeof strategies !== "object" || Array.isArray(strategies)) return;
    if (!Object.hasOwn(strategies, previousName) || Object.hasOwn(strategies, combo.id)) return;
    const next = { ...strategies, [combo.id]: strategies[previousName] };
    delete next[previousName];
    await updateSettings({ comboStrategies: next });
  } catch (error) {
    console.warn(`[combos] strategy key migration for ${combo.id} skipped:`, error.message);
  }
}

// GET /api/combos/[id] - Get combo by ID
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const combo = await getComboById(id);
    
    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }
    
    return NextResponse.json(combo);
  } catch (error) {
    console.log("Error fetching combo:", error);
    return NextResponse.json({ error: "Failed to fetch combo" }, { status: 500 });
  }
}

// PUT /api/combos/[id] - Update combo
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();

    if (body.isActive !== undefined && typeof body.isActive !== "boolean") {
      return NextResponse.json({ error: "isActive must be a boolean" }, { status: 400 });
    }
    const organizationError = validateComboOrganization(body);
    if (organizationError) {
      return NextResponse.json({ error: organizationError }, { status: 400 });
    }
    
    // Validate name format if provided
    if (body.name) {
      if (!VALID_NAME_REGEX.test(body.name)) {
        return NextResponse.json({ error: "Name can only contain letters, numbers, -, _ and ." }, { status: 400 });
      }
      
      // Check if name already exists (exclude current combo)
      const existing = await getComboByName(body.name);
      if (existing && existing.id !== id) {
        return NextResponse.json({ error: "Combo name already exists" }, { status: 400 });
      }
    }
    
    // Capture previous name to invalidate rotation state on rename.
    const prev = await getComboById(id);
    if (!prev) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    let updateData = body;
    const normalizedModels = body.models === undefined
      ? prev.models
      : normalizeComboModelsForStorage(body.models);
    if (normalizedModels === null) {
      return NextResponse.json({ error: "Invalid combo model schedule" }, { status: 400 });
    }
    const normalizedCapabilities = body.capabilities === undefined
      ? normalizeComboCapabilities(prev.capabilities)
      : normalizeComboCapabilities(body.capabilities);
    if (normalizedCapabilities === null) {
      return NextResponse.json({ error: "Context window must be a positive integer" }, { status: 400 });
    }
    await refreshModelCapabilityOverrides();
    const capabilityError = getComboCapabilityValidationError(normalizedModels, normalizedCapabilities, {
      // Validate the edited graph, not a stale copy of this combo (also on rename).
      combos: (await getCombos()).filter((combo) => combo.id !== id),
      comboPath: [body.name || prev.name],
    });
    if (capabilityError) {
      return NextResponse.json({ error: capabilityError }, { status: 400 });
    }
    const search = body.search === undefined ? (prev.search ?? null) : normalizeComboSearch(body.search);
    const searchError = search === undefined ? "Invalid combo search configuration" : getComboSearchValidationError(search, {
      kind: body.kind === undefined ? prev.kind : body.kind,
      models: normalizedModels,
      combos: (await getCombos()).filter((combo) => combo.id !== id),
      comboPath: [body.name || prev.name],
    });
    if (searchError) return NextResponse.json({ error: searchError }, { status: 400 });
    updateData = { ...updateData, search, models: normalizedModels, capabilities: normalizedCapabilities };
    if (body.accessTags !== undefined) updateData.accessTags = normalizeAccessTags(body.accessTags);

    if (body.groupName !== undefined) updateData = { ...updateData, groupName: body.groupName?.trim() || null };

    const combo = await updateCombo(id, updateData);
    
    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    // Invalidate rotation state (models/strategy/name may have changed). The
    // shared cursor is keyed by id, so it survives a rename; reset it too or the
    // new member list takes effect only after the old cursor walks around.
    if (prev?.name) resetComboRotation(prev.name);
    if (combo.name && combo.name !== prev?.name) resetComboRotation(combo.name);
    await resetComboRotationCount(combo.id);

    // Carry a legacy name-keyed strategy across a rename. Without this, the row
    // keeps pointing at a name that no longer exists and the combo silently
    // drops back to plain fallback routing.
    if (combo.name !== prev.name) await migrateLegacyStrategyKey(combo, prev.name);

    return NextResponse.json(combo);
  } catch (error) {
    console.log("Error updating combo:", error);
    return NextResponse.json({ error: "Failed to update combo" }, { status: 500 });
  }
}

// DELETE /api/combos/[id] - Delete combo
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const prev = await getComboById(id);
    const success = await deleteCombo(id);
    
    if (!success) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    if (prev?.name) resetComboRotation(prev.name);
    await resetComboRotationCount(id);
    await dropComboStrategy(id, prev?.name);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting combo:", error);
    return NextResponse.json({ error: "Failed to delete combo" }, { status: 500 });
  }
}
