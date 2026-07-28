import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  actOnWccHandoffPackage,
  getWccHandoffPackageDetails,
  type HandoffAction,
} from "@/services/wecom-file-handoff-service";

const ACTIONS = new Set<HandoffAction>(["retry", "align", "discard"]);

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    return NextResponse.json(await getWccHandoffPackageDetails(prisma, id));
  } catch (error) {
    const code = error instanceof Error ? error.message : "handoff_package_detail_failed";
    return NextResponse.json({ error: code }, { status: code === "package_not_found" ? 404 : 400 });
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const body = await request.json() as { action?: HandoffAction; studentId?: string };
    if (!body.action || !ACTIONS.has(body.action)) {
      return NextResponse.json({ error: "invalid_action" }, { status: 400 });
    }
    const result = await actOnWccHandoffPackage(
      prisma,
      id,
      body.action,
      body.studentId,
    );
    return NextResponse.json(result);
  } catch (error) {
    const raw = error instanceof Error ? error.message : "";
    const code = [
      "package_not_found",
      "invalid_action",
      "student_required",
      "package_conflict",
      "invalid_package",
      "hash_mismatch",
    ].includes(raw) ? raw : "handoff_action_failed";
    const status = ["package_not_found"].includes(code) ? 404 : 400;
    return NextResponse.json({ error: code }, { status });
  }
}
