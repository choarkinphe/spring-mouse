import { NextResponse } from "next/server";
import { API_KEY_QUOTA_RESET_FIELDS, API_KEY_QUOTA_WINDOWS } from "@/lib/apiKeyQuota";
import { deleteApiKey, getApiKeyById, updateApiKey } from "@/lib/localDb";

const QUOTA_MODES = new Set(["off", "limited", "unlimited"]);
const RESET_FIELDS = API_KEY_QUOTA_RESET_FIELDS;

// GET /api/keys/[id] - Get single key
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json({ key });
  } catch (error) {
    console.log("Error fetching key:", error);
    return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 });
  }
}

// PUT /api/keys/[id] - Update key
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { isActive, quotaMode, resetQuota, resetQuotaWindow } = body;

    const existing = await getApiKeyById(id);
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    if (quotaMode !== undefined && !QUOTA_MODES.has(quotaMode)) {
      return NextResponse.json({ error: "Invalid quota mode" }, { status: 400 });
    }

    const updateData = {};
    if (isActive !== undefined) updateData.isActive = isActive === true;
    if (quotaMode !== undefined) updateData.quotaMode = quotaMode;

    const resetAll = resetQuota === true;
    const windowId = resetQuotaWindow || (typeof resetQuota === "string" ? resetQuota : null);
    if (resetQuota !== undefined && resetQuota !== false && !resetAll && windowId === null) {
      return NextResponse.json({ error: "Invalid quota reset" }, { status: 400 });
    }
    if (windowId !== null && !RESET_FIELDS[windowId]) {
      return NextResponse.json({ error: "Invalid quota reset window" }, { status: 400 });
    }
    if (resetAll && resetQuotaWindow !== undefined) {
      return NextResponse.json({ error: "Conflicting quota reset requests" }, { status: 400 });
    }

    const now = Date.now();
    const nextResetAt = (id) => new Date(now + API_KEY_QUOTA_WINDOWS.find((window) => window.id === id).durationMs).toISOString();
    if (resetAll) {
      updateData.quotaResetAt = null;
      updateData.fiveHourQuotaResetAt = nextResetAt("fiveHour");
      updateData.weeklyQuotaResetAt = nextResetAt("weekly");
    } else if (windowId) {
      updateData[RESET_FIELDS[windowId]] = nextResetAt(windowId);
    }

    const updated = await updateApiKey(id, updateData);
    return NextResponse.json({ key: updated });
  } catch (error) {
    console.log("Error updating key:", error);
    return NextResponse.json({ error: "Failed to update key" }, { status: 500 });
  }
}

// DELETE /api/keys/[id] - Delete key
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const deleted = await deleteApiKey(id);
    if (!deleted) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Key deleted successfully" });
  } catch (error) {
    console.log("Error deleting key:", error);
    return NextResponse.json({ error: "Failed to delete key" }, { status: 500 });
  }
}
