import { NextResponse } from "next/server";
import { getMouseByAccessToken } from "@/lib/localDb";
import { deliverMouseResult, markMouseTaskStarted } from "@/lib/mouse/tunnel";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" };
// Node rejects request headers beyond ~16KB, so a replayed response head larger
// than this is dropped rather than allowed to fail the whole upload.
const MAX_HEADER_PAYLOAD = 8 * 1024;

function bearerToken(request) {
  return request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || "";
}

// The agent is replaying a real HTTP response, so the status line and headers
// travel ahead of the body: status in one header, headers as base64 JSON in
// another. Both are small (a provider response head, not a body).
function decodeUpstreamHeaders(value) {
  if (!value) return {};
  const raw = String(value);
  if (raw.length > MAX_HEADER_PAYLOAD) return {};
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const headers = {};
    for (const [key, headerValue] of Object.entries(parsed)) {
      if (typeof headerValue !== "string" || !key.trim()) continue;
      headers[key] = headerValue;
    }
    return headers;
  } catch {
    return {};
  }
}

/**
 * The agent's reply half of a task: the upstream status, the upstream headers
 * and then the upstream body as a live stream.
 *
 * The body is bridged rather than passed straight through, and the pipe is
 * awaited, because this handler must stay alive for exactly as long as the
 * response lasts. Returning early could let the runtime tear down the upload
 * while the caller is still reading it.
 */
export async function POST(request) {
  try {
    const mouse = await getMouseByAccessToken(bearerToken(request));
    if (!mouse) {
      return NextResponse.json({ error: "Mouse access token is invalid" }, { status: 401, headers: NO_STORE_HEADERS });
    }
    if (mouse.disabledAt) {
      return NextResponse.json({ error: "Mouse is disabled" }, { status: 403, headers: NO_STORE_HEADERS });
    }

    const taskId = request.headers.get("x-mouse-task-id")?.trim();
    if (!taskId) {
      return NextResponse.json({ error: "x-mouse-task-id is required" }, { status: 400, headers: NO_STORE_HEADERS });
    }

    // The handshake half of a result: the node says it has the task, and sends no
    // body at all. It has to be its own request — one that carries the upstream body
    // only becomes readable here after the whole upload has been buffered, and waiting
    // on that is exactly what used to consume the ack budget.
    if (request.headers.get("x-mouse-phase") === "started") {
      const accepted = markMouseTaskStarted(taskId);
      return NextResponse.json({ started: accepted }, { status: accepted ? 200 : 404, headers: NO_STORE_HEADERS });
    }

    const status = Number(request.headers.get("x-upstream-status"));
    const headers = decodeUpstreamHeaders(request.headers.get("x-upstream-headers"));

    const bridge = new TransformStream();
    const delivered = deliverMouseResult(taskId, {
      status: Number.isInteger(status) && status >= 200 && status <= 599 ? status : 200,
      headers,
      body: bridge.readable,
    });

    if (!delivered) {
      // The task already timed out or was cancelled. Drain the upload so the
      // agent sees a clean response instead of a reset connection.
      try {
        await request.body?.cancel?.();
      } catch {}
      return NextResponse.json({ error: "Task is no longer pending" }, { status: 404, headers: NO_STORE_HEADERS });
    }

    if (request.body) {
      await request.body.pipeTo(bridge.writable).catch(() => {});
    } else {
      await bridge.writable.close().catch(() => {});
    }

    return new Response(null, { status: 200, headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[API] Failed to record mouse task result:", error);
    return NextResponse.json({ error: "Failed to record task result" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
