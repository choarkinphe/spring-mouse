import { NextResponse } from "next/server";
import { getRequestDetailByRequestId } from "@/lib/usageDb";
import { summarizeChatRequest } from "@/lib/requestDetailCompact.js";

const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" };

/**
 * GET /api/usage/request-details/conversation?requestId=...
 *
 * Returns ONLY the bounded conversation digest for one request — "what did the
 * user send this turn" — so the board's detail table can expand a row without
 * shipping the full request/response payloads the list endpoint redacts.
 *
 * The digest is produced by `summarizeChatRequest` (the same bounded helper the
 * observability writer uses when a body is too large to store), so the response
 * is capped by construction: at most 12 messages / 400 chars each / 6000 total.
 * A body small enough to store whole carries no `_summary`, so the digest is
 * computed on read; a compacted body already has one.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const requestId = searchParams.get("requestId");
    if (!requestId || requestId.length > 128) {
      return NextResponse.json({ error: "Invalid requestId" }, { status: 400, headers: NO_STORE_HEADERS });
    }

    const detail = await getRequestDetailByRequestId(requestId);
    if (!detail) {
      return NextResponse.json({ conversation: null, notice: "未找到该请求的对话明细（可能已超出保留范围）。" }, { headers: NO_STORE_HEADERS });
    }

    // A compacted body stores the digest already; otherwise summarize the body.
    const conversation = detail.request?._summary
      || summarizeChatRequest(detail.request)
      || null;

    return NextResponse.json({
      conversation,
      notice: conversation ? null : "该请求未记录可展示的对话内容（非对话类请求，或报文已清理）。",
    }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[API] Failed to get request conversation:", error);
    return NextResponse.json({ error: "Failed to fetch request conversation" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
