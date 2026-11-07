import { existsSync } from "node:fs";
import {
  beginDevinSession,
  pollDevinSession,
  completeDevinSession,
  cancelDevinSession,
  DevinOAuthError,
} from "@/lib/oauth/utils/devinServer.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function errorResponse(error) {
  return json({ error: error instanceof DevinOAuthError ? error.message : "Devin authorization failed" },
    error instanceof DevinOAuthError ? error.status : 500);
}

// DashboardGuard authenticates /api/oauth/*; add an explicit mutation origin
// check as well. A CLI without Origin is allowed, cross-site browser calls aren't.
function sameOrigin(request) {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.origin === new URL(request.url).origin
      && parsed.host === (request.headers.get("host") || new URL(request.url).host);
  } catch { return false; }
}

function localCallbackAvailable(request) {
  const hostname = new URL(request.url).hostname;
  // A localhost dashboard may still be a port-forward to a container. Never
  // assume its server loopback is accessible from the user's browser.
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname)
    && !process.env.KUBERNETES_SERVICE_HOST && !process.env.container
    && !existsSync("/.dockerenv") && !existsSync("/run/.containerenv");
}

export async function GET(request, { params }) {
  try {
    const { action } = await params;
    if (action !== "poll-status") return json({ error: "Unknown action" }, 400);
    return json(pollDevinSession(new URL(request.url).searchParams.get("state")));
  } catch (error) { return errorResponse(error); }
}

export async function POST(request, { params }) {
  if (!sameOrigin(request)) return json({ error: "Cross-origin OAuth request rejected" }, 403);
  try {
    const { action } = await params;
    let body;
    try { body = await request.json(); } catch { return json({ error: "Invalid request body" }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Invalid request body" }, 400);
    if (action === "begin") {
      if (body.mode !== undefined && !["manual", "local"].includes(body.mode)) return json({ error: "Invalid Devin login mode" }, 400);
      const mode = body.mode === "local" && localCallbackAvailable(request) ? "local" : "manual";
      return json(await beginDevinSession({ mode }));
    }
    if (action === "complete") {
      const connection = await completeDevinSession(body.state, body.code);
      return json({ success: true, connection });
    }
    if (action === "cancel") {
      cancelDevinSession(body.state);
      return json({ success: true });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (error) { return errorResponse(error); }
}
