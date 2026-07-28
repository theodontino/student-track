import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { retryWccHandoffPackages } from "@/services/wecom-file-handoff-service";

const MAX_BATCH_SIZE = 25;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { ids?: unknown };
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    if (ids.length === 0) return NextResponse.json({ error: "ids 不能为空" }, { status: 400 });
    if (ids.length > MAX_BATCH_SIZE) {
      return NextResponse.json({ error: `单次最多重试 ${MAX_BATCH_SIZE} 个包` }, { status: 400 });
    }
    return NextResponse.json(await retryWccHandoffPackages(prisma, ids));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "handoff_batch_retry_failed" }, { status: 400 });
  }
}
