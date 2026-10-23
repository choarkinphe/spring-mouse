import { getProviderConnectionById } from "@/lib/db/repos/connectionsRepo.js";
import { getCheckinState } from "@/lib/db/repos/checkinRepo.js";
import { publicCheckinState, runCodeBuddyCheckin, setCodeBuddyCheckinEnabled } from "@/lib/services/codebuddyCheckin.js";
import { supportsCodeBuddyCheckin } from "@/shared/config/codebuddyCheckin.js";

async function validate(params) {
  const { id } = await params;
  const connection = await getProviderConnectionById(id);
  if (!connection) return { error: "账号不存在", status: 404 };
  if (!supportsCodeBuddyCheckin(connection)) return { error: "仅支持 CodeBuddy 国内版 OAuth 账号签到", status: 400 };
  return { id };
}

export async function GET(request, { params }) {
  try {
    const target = await validate(params);
    if (target.error) return Response.json({ error: target.error }, { status: target.status });
    return Response.json({ checkin: publicCheckinState(await getCheckinState(target.id)) });
  } catch {
    return Response.json({ error: "读取签到状态失败" }, { status: 500 });
  }
}

export async function PATCH(request, { params }) {
  try {
    const target = await validate(params);
    if (target.error) return Response.json({ error: target.error }, { status: target.status });
    const body = await request.json().catch(() => null);
    if (typeof body?.enabled !== "boolean") return Response.json({ error: "enabled 必须为布尔值" }, { status: 400 });
    return Response.json({ checkin: await setCodeBuddyCheckinEnabled(target.id, body.enabled) });
  } catch {
    return Response.json({ error: "保存自动签到设置失败" }, { status: 500 });
  }
}

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const result = await runCodeBuddyCheckin(id);
    return Response.json(result, { status: result.httpStatus || (result.ok || result.skipped ? 200 : 502) });
  } catch {
    return Response.json({ ok: false, error: "签到失败，请稍后重试" }, { status: 500 });
  }
}
