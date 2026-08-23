import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { clearDashboardAuthCookie, clearDashboardMfaChallengeCookie } from "@/lib/auth/dashboardSession";

export async function POST() {
  const cookieStore = await cookies();
  clearDashboardAuthCookie(cookieStore);
  clearDashboardMfaChallengeCookie(cookieStore);
  return NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
}
