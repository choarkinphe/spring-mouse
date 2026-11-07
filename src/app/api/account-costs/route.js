import { getAccountCosts } from "@/lib/db/repos/accountBillingRepo.js";
import { normalizeBillingRange } from "@/shared/utils/accountBilling.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const search = new URL(request.url).searchParams;
  let range;
  try {
    range = normalizeBillingRange(search.get("start"), search.get("end"));
    if (search.has("connectionId") && !search.get("connectionId")?.trim()) throw new Error("connectionId must not be empty");
  } catch (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  try {
    return Response.json(await getAccountCosts({
      ...range,
      ...(search.has("connectionId") ? { connectionId: search.get("connectionId") } : {}),
    }));
  } catch {
    return Response.json({ error: "Unable to generate account costs report" }, { status: 500 });
  }
}
