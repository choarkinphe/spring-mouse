import { getAccountBilling, setAccountBillingMode, appendAccountBillingEntry } from "@/lib/db/repos/accountBillingRepo.js";
import { isBillingMode, normalizeBillingEntry } from "@/shared/utils/accountBilling.js";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const billing = await getAccountBilling(id);
    return billing ? Response.json({ billing }) : Response.json({ error: "Account not found" }, { status: 404 });
  } catch {
    return Response.json({ error: "Unable to read account billing" }, { status: 500 });
  }
}

export async function PATCH(request, { params }) {
  const body = await request.json().catch(() => null);
  if (!isBillingMode(body?.mode)) return Response.json({ error: "Invalid billing mode" }, { status: 400 });
  try {
    const { id } = await params;
    const billing = await setAccountBillingMode(id, body.mode);
    return billing ? Response.json({ billing }) : Response.json({ error: "Account not found" }, { status: 404 });
  } catch {
    return Response.json({ error: "Unable to save billing mode" }, { status: 500 });
  }
}

export async function POST(request, { params }) {
  const body = await request.json().catch(() => null);
  let entry;
  try {
    entry = normalizeBillingEntry(body);
  } catch (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  try {
    const { id } = await params;
    const billing = await appendAccountBillingEntry(id, entry);
    return billing ? Response.json({ billing }) : Response.json({ error: "Account not found" }, { status: 404 });
  } catch (error) {
    if (error.status === 409) return Response.json({ error: error.message }, { status: 409 });
    return Response.json({ error: "Unable to append billing entry" }, { status: 500 });
  }
}
