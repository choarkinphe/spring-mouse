import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getMouseById } from "@/lib/localDb";
import { dispatchMouseTask, isTunnelConnected } from "@/lib/mouse/tunnel";
import { runWithAbortDeadline } from "open-sse/utils/abortable.js";

export const dynamic = "force-dynamic";
const TEST_TIMEOUT_MS = 10_000;
const headers = { "Cache-Control": "no-store" };

// Dashboard-authenticated diagnostic. No account binding or provider credentials
// are needed: POST to Spring's read-only version endpoint must return 405.
// This exercises dispatch, agent HTTP execution and the authenticated result relay.
export async function POST(request, { params }) {
  const { id } = await params;
  const mouse = await getMouseById(id);
  if (!mouse) return NextResponse.json({ error: "Mouse 不存在" }, { status: 404, headers });
  if (mouse.disabledAt || !isTunnelConnected(id)) {
    return NextResponse.json({ error: "Mouse 没有可用的实时连接" }, { status: 409, headers });
  }
  let target;
  try {
    const body = await request.json();
    const origin = new URL(body.springUrl);
    if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password) throw new Error();
    target = new URL("/api/version", origin.origin).href;
  } catch {
    return NextResponse.json({ error: "请提供有效的 Spring 地址" }, { status: 400, headers });
  }
  const started = Date.now();
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal]);
  try {
    const status = await runWithAbortDeadline(async () => {
      const result = await dispatchMouseTask(id, {
        taskId: randomUUID(), signal,
        request: { method: "POST", url: target, headers: { "Content-Type": "application/json" }, body: "{}" },
      });
      // Do not return response payloads: an intercepted endpoint may contain
      // arbitrary content. Cancelling also releases a non-empty relay promptly.
      await result.body?.cancel?.();
      return result.status;
    }, { signal: request.signal, timeoutMs: TEST_TIMEOUT_MS, onTimeout: error => controller.abort(error) });
    return NextResponse.json({ ok: status === 405, upstreamStatus: status, elapsedMs: Date.now() - started,
      scope: "task_round_trip", providerTested: false,
      ...(status === 405 ? {} : { error: "任务已返回，但 Spring 探测响应与预期不符" }) }, { headers });
  } catch (error) {
    return NextResponse.json({ ok: false, elapsedMs: Date.now() - started,
      error: error.name === "TimeoutError" ? "Mouse 任务往返测试超时" : "Mouse 任务往返测试失败" },
    { status: error.name === "AbortError" ? 499 : 503, headers });
  }
}
