import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { getBackupStatus, startLitestream, stopLitestream } from "@/lib/backup/litestream";
import { setBackupEnabled } from "@/lib/backup/destinationsStore";
import { performRestore, getRestoreState } from "@/lib/backup/restore";
import { verifyDashboardPassword } from "@/lib/auth/dashboardSession";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const HEADERS = { "Cache-Control": "no-store" };
const CLI_TOKEN_HEADER = "x-9r-cli-token";
const PASSWORD_HEADER = "x-9r-password";

function isCliRequest(request) {
  return Boolean(request.headers.get(CLI_TOKEN_HEADER));
}

async function authorize(request, password) {
  if (isCliRequest(request)) return true;
  return verifyDashboardPassword(password ?? request.headers.get(PASSWORD_HEADER));
}

// GET — replication status. Read-only, so it only needs the dashboard session
// (the whole dashboard is behind login; this adds no new exposure).
export async function GET() {
  try {
    const settings = await getSettings();
    const status = await getBackupStatus(settings);
    const restore = getRestoreState();
    return NextResponse.json({ ...status, restore }, { headers: HEADERS });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// PATCH — the enable switch. `{ enabled: boolean }`. Kept off the generic
// settings PATCH because the engine must be started against the CANDIDATE state
// before the row is written; persisting first (as that handler used to) left the
// database enabled even when the start failed.
export async function PATCH(request) {
  try {
    const body = await request.json().catch(() => ({}));
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
    }
    await setBackupEnabled(body.enabled);
    const settings = await getSettings();
    return NextResponse.json(
      { ok: true, enabled: settings.backupEnabled === true, status: await getBackupStatus(settings) },
      { headers: HEADERS },
    );
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}

// POST — actions. Restoring REPLACES the database, so unlike GET it requires the
// password re-confirmation the existing import flow uses.
//   action=start   → begin replication now
//   action=stop    → stop replication
//   action=restore → stage + verify a restore, then exit so entrypoint swaps it
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const action = String(body.action || "").trim();
    const settings = await getSettings();

    if (action === "start" || action === "stop") {
      if (settings.backupEnabled !== true) {
        return NextResponse.json({ error: "Backup is disabled in settings" }, { status: 400 });
      }
      if (action === "start") {
        const result = await startLitestream(settings);
        return NextResponse.json({ ok: true, ...result, status: await getBackupStatus(settings) }, { headers: HEADERS });
      }
      stopLitestream();
      return NextResponse.json({ ok: true, status: await getBackupStatus(settings) }, { headers: HEADERS });
    }

    if (action === "restore") {
      if (!(await authorize(request, body.password))) {
        return NextResponse.json({ error: "Invalid password" }, { status: 401 });
      }
      if (settings.backupEnabled !== true) {
        return NextResponse.json({ error: "Backup is disabled in settings" }, { status: 400 });
      }

      const result = await performRestore({ settings, timestamp: body.timestamp || "" });
      if (!result.ok) {
        return NextResponse.json({ error: result.error || "Restore failed" }, { status: 400 });
      }

      // The swap happens on the NEXT boot, so the process must exit for it to
      // take effect. Answer first — the client needs the response before the
      // server goes away — then exit; `restart: always` brings it back.
      setTimeout(() => process.exit(0), 1500).unref?.();
      return NextResponse.json(
        { ok: true, bytes: result.bytes, restarting: true, message: "Restore staged; the service is restarting to apply it." },
        { headers: HEADERS },
      );
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
