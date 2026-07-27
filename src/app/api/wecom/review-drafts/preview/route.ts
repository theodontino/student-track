import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { startPreReview } from "@/services/wecom-prereview-service";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as { draftIds?: unknown };
    const draftIds = Array.isArray(body.draftIds)
      ? body.draftIds.filter((value): value is string => typeof value === "string" && value.startsWith("wcc-"))
      : undefined;
    const status = await startPreReview(prisma, { ...(draftIds ? { draftIds } : {}) });
    return NextResponse.json(status);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "prereview_start_failed" }, { status: 400 });
  }
}
