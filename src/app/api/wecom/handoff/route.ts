import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  listWccHandoffPackages,
  scanAndConsumeWccPackages,
} from "@/services/wecom-file-handoff-service";

export async function GET() {
  try {
    return NextResponse.json(await listWccHandoffPackages(prisma));
  } catch {
    return NextResponse.json({ error: "handoff_status_failed" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as { limit?: number };
    return NextResponse.json(await scanAndConsumeWccPackages(prisma, body.limit || 20));
  } catch {
    return NextResponse.json({ error: "handoff_scan_failed" }, { status: 500 });
  }
}
