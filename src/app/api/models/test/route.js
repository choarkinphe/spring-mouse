import { NextResponse } from "next/server";
import { pingModelByKind } from "./ping";
import { getProviderConnectionById } from "@/models";

// POST /api/models/test - Ping a single model via internal completions or embeddings
export async function POST(request) {
  try {
    const { model, kind, connectionId } = await request.json();
    if (!model) return NextResponse.json({ error: "Model required" }, { status: 400 });
    if (kind === "image" && /^(cx|codex)\//.test(model)) {
      const connection = typeof connectionId === "string" && connectionId ? await getProviderConnectionById(connectionId) : null;
      if (!connection || connection.provider !== "codex" || connection.isActive === false) {
        return NextResponse.json({ ok: false, error: "请选择用于出图测试的启用 Codex 账号" }, { status: 400 });
      }
    }
    const result = await pingModelByKind(model, kind || "llm", undefined, { connectionId });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
