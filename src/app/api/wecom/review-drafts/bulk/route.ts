import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { bulkReviewDrafts } from "@/services/wecom-prereview-service";

const MAX_DRAFT_IDS = 500;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { draftIds?: unknown; action?: unknown; concurrency?: unknown };
    const ids = Array.isArray(body.draftIds)
      ? body.draftIds.filter((value): value is string => typeof value === "string" && value.startsWith("wcc-"))
      : [];
    if (ids.length === 0) {
      return NextResponse.json({ error: "draftIds 不能为空" }, { status: 400 });
    }
    if (ids.length > MAX_DRAFT_IDS) {
      return NextResponse.json({ error: `单次最多批量 ${MAX_DRAFT_IDS} 条` }, { status: 400 });
    }
    if (body.action !== "confirm" && body.action !== "reject") {
      return NextResponse.json({ error: "action 必须是 confirm 或 reject" }, { status: 400 });
    }
    const concurrency = typeof body.concurrency === "number" && body.concurrency > 0
      ? Math.min(body.concurrency, 8)
      : 4;
    const result = await bulkReviewDrafts(prisma, ids, body.action, { concurrency });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "bulk_review_failed" }, { status: 400 });
  }
}
