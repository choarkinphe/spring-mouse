import { NextResponse } from "next/server";
import { normalizeComboModelsForStorage, normalizeComboCapabilities, getComboCapabilityValidationError } from "open-sse/services/combo.js";
import { getCombos, createCombo, getComboByName } from "@/lib/localDb";
import { refreshModelCapabilityOverrides } from "@/lib/modelCapabilityOverrides";

export const dynamic = "force-dynamic";

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

// GET /api/combos - Get all combos
export async function GET() {
  try {
    const combos = await getCombos();
    return NextResponse.json({ combos });
  } catch (error) {
    console.log("Error fetching combos:", error);
    return NextResponse.json({ error: "Failed to fetch combos" }, { status: 500 });
  }
}

// POST /api/combos - Create new combo
export async function POST(request) {
  try {
    const body = await request.json();
    const { name, models, kind, isActive, groupName, sortOrder, capabilities } = body;

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    if (isActive !== undefined && typeof isActive !== "boolean") {
      return NextResponse.json({ error: "isActive must be a boolean" }, { status: 400 });
    }
    const organizationError = validateComboOrganization({ groupName, sortOrder });
    if (organizationError) {
      return NextResponse.json({ error: organizationError }, { status: 400 });
    }

    // Validate name format
    if (!VALID_NAME_REGEX.test(name)) {
      return NextResponse.json({ error: "Name can only contain letters, numbers, -, _ and ." }, { status: 400 });
    }

    // Check if name already exists
    const existing = await getComboByName(name);
    if (existing) {
      return NextResponse.json({ error: "Combo name already exists" }, { status: 400 });
    }

    const normalizedModels = normalizeComboModelsForStorage(models || []);
    if (normalizedModels === null) {
      return NextResponse.json({ error: "Invalid combo model schedule" }, { status: 400 });
    }
    const normalizedCapabilities = normalizeComboCapabilities(capabilities);
    if (normalizedCapabilities === null) {
      return NextResponse.json({ error: "Context window must be a positive integer" }, { status: 400 });
    }
    await refreshModelCapabilityOverrides();
    const capabilityError = getComboCapabilityValidationError(normalizedModels, normalizedCapabilities);
    if (capabilityError) {
      return NextResponse.json({ error: capabilityError }, { status: 400 });
    }

    const combo = await createCombo({ name, models: normalizedModels, kind: kind || null, isActive, groupName: groupName?.trim() || null, sortOrder, capabilities: normalizedCapabilities });

    return NextResponse.json(combo, { status: 201 });
  } catch (error) {
    console.log("Error creating combo:", error);
    return NextResponse.json({ error: "Failed to create combo" }, { status: 500 });
  }
}
