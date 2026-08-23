import { NextResponse } from "next/server";
import pkg from "../../../../package.json" with { type: "json" };

// Spring Mouse is an internal fork: releases are tracked by git + Jenkins
// (image revision label / build-info.json), not by the npm registry.
// The upstream `9router` npm check was removed — comparing our own version
// line (0.x) against upstream (0.5.x) would flag a permanent bogus update.
// Response shape is unchanged for the dashboard.

export async function GET() {
  const currentVersion = pkg.version;
  return NextResponse.json({ currentVersion, latestVersion: currentVersion, hasUpdate: false });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*" } });
}
