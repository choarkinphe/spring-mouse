import { NextResponse } from "next/server";
import { normalizeComboModelsForStorage, normalizeComboCapabilities, getComboCapabilityValidationError, resetComboRotation } from "open-sse/services/combo.js";
import { getComboById, updateCombo, deleteCombo, getComboByName } from "@/lib/localDb";
import { refreshModelCapabilityOverrides } from "@/lib/modelCapabilityOverrides";

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
    const capabilityError = getComboCapabilityValidationError(normalizedModels, normalizedCapabilities);
    if (capabilityError) {
      return NextResponse.json({ error: capabilityError }, { status: 400 });
    }
    updateData = { ...updateData, models: normalizedModels, capabilities: normalizedCapabilities };

    if (body.groupName !== undefined) updateData = { ...updateData, groupName: body.groupName?.trim() || null };

    const combo = await updateCombo(id, updateData);
    
    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    // Invalidate rotation state (models/strategy/name may have changed)
    if (prev?.name) resetComboRotation(prev.name);
    if (combo.name && combo.name !== prev?.name) resetComboRotation(combo.name);

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
    
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting combo:", error);
    return NextResponse.json({ error: "Failed to delete combo" }, { status: 500 });
  }
}
