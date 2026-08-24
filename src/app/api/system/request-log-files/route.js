import { NextResponse } from "next/server";
import {
  clearRequestLogFiles,
  getRequestLogSession,
  listRequestLogSessions,
  readRequestLogFile,
} from "@/lib/requestLogStorage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function badRequest(error) {
  return NextResponse.json({ error: error?.message || "Invalid request" }, { status: 400 });
}

export async function GET(request) {
  const { searchParams } = request.nextUrl;
  const session = searchParams.get("session");
  const file = searchParams.get("file");

  try {
    if (file && !session) return badRequest(new Error("A session is required to read a log file"));
    if (file) return NextResponse.json(await readRequestLogFile(session, file));
    if (session) return NextResponse.json(await getRequestLogSession(session));
    return NextResponse.json(await listRequestLogSessions());
  } catch (error) {
    if (error?.code === "ENOENT" || error?.message?.includes("not found")) {
      return NextResponse.json({ error: "Log entry not found" }, { status: 404 });
    }
    if (error?.message?.startsWith("Invalid")) return badRequest(error);
    console.error("[RequestLogFiles] Failed to read logs:", error);
    return NextResponse.json({ error: "Failed to read log files" }, { status: 500 });
  }
}

export async function DELETE(request) {
  const session = request.nextUrl.searchParams.get("session");
  try {
    const result = await clearRequestLogFiles(session);
    if (session && result.skippedActiveSessions?.length) {
      return NextResponse.json(
        { error: "Log session is still active", ...result },
        { status: 409 },
      );
    }
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error?.message?.startsWith("Invalid")) return badRequest(error);
    console.error("[RequestLogFiles] Failed to clear logs:", error);
    return NextResponse.json({ error: "Failed to clear log files" }, { status: 500 });
  }
}
