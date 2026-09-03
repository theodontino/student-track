import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { acceptHighConfidenceDrafts, filterAvailableWccDrafts } from "@/services/wecom-prereview-service";

const MIN_THRESHOLD = 0;
const MAX_THRESHOLD = 1;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as { threshold?: unknown; dryRun?: unknown };
    const threshold = typeof body.threshold === "number" ? body.threshold : 0.9;
    if (threshold < MIN_THRESHOLD || threshold > MAX_THRESHOLD) {
      return NextResponse.json({ error: "threshold 必须在 0 到 1 之间" }, { status: 400 });
    }
    const dryRun = Boolean(body.dryRun);
    if (dryRun) {
      // Cheap dry-run: count only.
      const candidates = await prisma.draftRecord.findMany({
        where: { status: "pending", id: { startsWith: "wcc-" }, sessionCode: { not: null } },
        select: { reviewResult: true, sessionCode: true },
        take: 2000,
      });
      const drafts = await filterAvailableWccDrafts(prisma, candidates);
      let eligible = 0;
      for (const draft of drafts) {
        if (!draft.reviewResult) continue;
        try {
          const data = JSON.parse(draft.reviewResult) as { verdict?: string; confidence?: number };
          if (data.verdict === "confirm" && typeof data.confidence === "number" && data.confidence >= threshold) {
            eligible += 1;
          }
        } catch { /* ignore */ }
      }
      return NextResponse.json({ scanned: drafts.length, eligible, confirmed: 0, failed: [], dryRun: true });
    }
    const result = await acceptHighConfidenceDrafts(prisma, threshold);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "accept_confidence_failed" }, { status: 400 });
  }
}
