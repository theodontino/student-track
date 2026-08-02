import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { apiErrorBody, ApiError, safeApiError } from "@/lib/api-errors";
import { resolvePreferenceCandidate } from "@/services/feedback-plan-service";

type Context = { params: Promise<{ id: string; candidateId: string }> };

export async function PATCH(request: NextRequest, context: Context) {
  try {
    const { id, candidateId } = await context.params;
    const body = await request.json().catch(() => null) as { decision?: string } | null;
    if (body?.decision !== "confirmed" && body?.decision !== "rejected") {
      throw new ApiError("decision 必须是 confirmed 或 rejected", 400, "invalid_request", false);
    }
    const existing = await prisma.communicationPreferenceCandidate.findUnique({ where: { id: candidateId }, select: { studentId: true } });
    if (!existing) throw new ApiError("候选不存在", 404, "not_found", false);
    if (existing.studentId !== id) throw new ApiError("候选与学生不匹配", 409, "conflict", false);
    const candidate = await resolvePreferenceCandidate(candidateId, body.decision);
    return NextResponse.json({ candidate });
  } catch (error) {
    const failure = safeApiError(error, "更新沟通偏好候选失败");
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
  }
}
