import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSettings } from "@/lib/localDb";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";

export async function GET() {
  try {
    const settings = await getSettings();
    const cookieStore = await cookies();
    const session = await getDashboardAuthSession(cookieStore.get("auth_token")?.value);

    return NextResponse.json({
      requireLogin: settings.requireLogin !== false,
      hasPassword: !!settings.password,
      displayName: session ? "Password user" : "",
      loginMethod: "Password",
      authenticated: !!session,
    });
  } catch {
    return NextResponse.json({
      requireLogin: true,
      hasPassword: false,
      displayName: "",
      loginMethod: "Password",
      authenticated: false,
    });
  }
}
