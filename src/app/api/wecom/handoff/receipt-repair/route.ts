import { NextRequest, NextResponse } from "next/server";
import { apiErrorBody, safeApiError } from "@/lib/api-errors";
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
  } catch (error) {
    const failure = safeApiError(error, "handoff_receipt_preview_failed");
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
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
    const failure = safeApiError(error, "handoff_receipt_repair_failed");
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
  }
}
