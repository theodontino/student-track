import { NextRequest, NextResponse } from "next/server";
import { apiErrorBody, safeApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import {
  previewWccPendingAlignmentRecovery,
  recoverWccPendingAlignments,
} from "@/services/wecom-file-handoff-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await previewWccPendingAlignmentRecovery(prisma));
  } catch (error) {
    const failure = safeApiError(error, "handoff_alignment_preview_failed");
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as {
      confirmation?: string;
      limit?: number;
    };
    return NextResponse.json(await recoverWccPendingAlignments(
      prisma,
      body.confirmation || "",
      body.limit || 25,
    ));
  } catch (error) {
    if (error instanceof Error && error.message === "confirmation_required") {
      return NextResponse.json({ error: "confirmation_required" }, { status: 400 });
    }
    const failure = safeApiError(error, "handoff_alignment_recovery_failed");
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
  }
}
