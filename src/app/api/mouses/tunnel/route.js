import { NextResponse } from "next/server";
import { getMouseByAccessToken, touchMouseHeartbeat } from "@/lib/localDb";
import { registerTunnel, unregisterTunnel } from "@/lib/mouse/tunnel";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Keeps intermediaries from closing an idle stream. It doubles as the node's
// liveness signal: holding a tunnel open is what "online" means now, so the
// keepalive also refreshes lastHeartbeatAt and the 30s heartbeat POST only has
// to cover a node that cannot hold a stream.
const PING_INTERVAL_MS = 15_000;

const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" };

function bearerToken(request) {
  return request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || "";
}

/**
 * The agent's end of the reverse connection. Auth uses the same access token as
 * register/heartbeat: the token *is* the node's identity, so a valid token is
 * the only thing needed to claim a tunnel slot.
 */
export async function GET(request) {
  const mouse = await getMouseByAccessToken(bearerToken(request));
  if (!mouse) {
    return NextResponse.json({ error: "Mouse access token is invalid" }, { status: 401, headers: NO_STORE_HEADERS });
  }
  if (mouse.disabledAt) {
    return NextResponse.json({ error: "Mouse is disabled" }, { status: 403, headers: NO_STORE_HEADERS });
  }

  const encoder = new TextEncoder();
  let controller = null;
  let pingTimer = null;
  let closed = false;

  const handle = {
    send(event, data) {
      if (closed || !controller) return false;
      try {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        return true;
      } catch {
        closed = true;
        return false;
      }
    },
    close() {
      closed = true;
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      try {
        controller?.close();
      } catch {}
    },
  };

  function cleanup() {
    if (closed && !pingTimer) return;
    handle.close();
    unregisterTunnel(mouse.id, handle);
  }

  const stream = new ReadableStream({
    start(streamController) {
      controller = streamController;
      registerTunnel(mouse.id, handle);

      // A tunnel cannot exist without a valid token, so opening one is proof
      // enough that the node is registered — even if its register POST was lost.
      void touchMouseHeartbeat(mouse.id).catch(() => {});

      handle.send("ready", {
        mouseId: mouse.id,
        clientId: mouse.clientId,
        pingIntervalSeconds: PING_INTERVAL_MS / 1000,
      });

      pingTimer = setInterval(() => {
        if (!handle.send("ping", { at: Date.now() })) return;
        void touchMouseHeartbeat(mouse.id).catch(() => {});
      }, PING_INTERVAL_MS);
      pingTimer.unref?.();
    },
    cancel() {
      cleanup();
    },
  });

  request.signal?.addEventListener?.("abort", cleanup, { once: true });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "Connection": "keep-alive",
      // Tells nginx not to buffer the stream, which would hold every task event
      // until the buffer filled.
      "X-Accel-Buffering": "no",
    },
  });
}
