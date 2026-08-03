import { NextRequest, NextResponse } from "next/server";
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
  } catch {
    return NextResponse.json({ error: "handoff_alignment_preview_failed" }, { status: 500 });
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
    const message = error instanceof Error ? error.message : "handoff_alignment_recovery_failed";
    return NextResponse.json(
      { error: message },
      { status: message === "confirmation_required" ? 400 : 500 },
    );
  }
}
