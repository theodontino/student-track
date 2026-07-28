import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  previewWccHandoffReceiptRepair,
  repairWccHandoffReceipts,
} from "@/services/wecom-handoff-receipt-repair-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await previewWccHandoffReceiptRepair(prisma));
  } catch {
    return NextResponse.json({ error: "handoff_receipt_preview_failed" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as { confirmation?: string };
    return NextResponse.json(await repairWccHandoffReceipts(prisma, body.confirmation || ""));
  } catch (error) {
    if (error instanceof Error && error.message === "confirmation_required") {
      return NextResponse.json({ error: "confirmation_required" }, { status: 400 });
    }
    return NextResponse.json({ error: "handoff_receipt_repair_failed" }, { status: 500 });
  }
}
