import { NextResponse } from "next/server";
import { getUsageDetails } from "@/lib/usageDb";

const FILTER_KEYS = ["provider", "model", "connectionId", "apiKeyId", "status", "appName", "sourceIp"];

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const page = Number(searchParams.get("page") || 1);
    const pageSize = Number(searchParams.get("pageSize") || 20);
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");

    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      return NextResponse.json({ error: "Invalid pagination" }, { status: 400 });
    }
    if ((startDate && Number.isNaN(Date.parse(startDate))) || (endDate && Number.isNaN(Date.parse(endDate))) || (startDate && endDate && Date.parse(startDate) > Date.parse(endDate))) {
      return NextResponse.json({ error: "Invalid date range" }, { status: 400 });
    }

    const filter = { page, pageSize, startDate, endDate };
    for (const key of FILTER_KEYS) {
      const value = searchParams.get(key);
      if (value) filter[key] = value.slice(0, 256);
    }

    return NextResponse.json(await getUsageDetails(filter));
  } catch (error) {
    console.error("[API] Failed to get usage details:", error);
    return NextResponse.json({ error: "Failed to fetch usage details" }, { status: 500 });
  }
}
