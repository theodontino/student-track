import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { apiErrorBody, ApiError, safeApiError } from "@/lib/api-errors";
import { CommunicationPreferenceSchema } from "@/lib/feedback-plan";
import { createPreferenceCandidate } from "@/services/feedback-plan-service";

type Context = { params: Promise<{ id: string }> };

function errorResponse(error: unknown, fallback: string) {
  const failure = safeApiError(error, fallback);
  return NextResponse.json(apiErrorBody(failure), { status: failure.status });
}

function parseJson(value: string | null | undefined) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

export async function GET(_request: NextRequest, context: Context) {
  try {
    const { id } = await context.params;
    const student = await prisma.student.findUnique({
      where: { id },
      select: {
        id: true,
        communicationPreference: true,
        communicationPreferenceCandidates: { orderBy: { createdAt: "desc" }, take: 30 },
      },
    });
    if (!student) throw new ApiError("学生不存在", 404, "not_found", false);
    return NextResponse.json({
      preference: student.communicationPreference
        ? { ...student.communicationPreference, preference: parseJson(student.communicationPreference.preferenceSnapshot) }
        : null,
      candidates: student.communicationPreferenceCandidates.map((candidate) => ({
        id: candidate.id,
        sourceType: candidate.sourceType,
        sourceId: candidate.sourceId,
        status: candidate.status,
        preference: parseJson(candidate.preferenceSnapshot),
        evidence: parseJson(candidate.evidenceSnapshot),
        createdAt: candidate.createdAt,
        reviewedAt: candidate.reviewedAt,
      })),
    });
  } catch (error) {
    return errorResponse(error, "读取沟通偏好失败");
  }
}

export async function POST(request: NextRequest, context: Context) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) throw new ApiError("沟通偏好参数无效", 400, "invalid_request", false);
    const parsed = CommunicationPreferenceSchema.safeParse(body.preference);
    if (!parsed.success) throw new ApiError("沟通偏好格式无效", 400, "invalid_request", false);
    const student = await prisma.student.findUnique({ where: { id }, select: { id: true } });
    if (!student) throw new ApiError("学生不存在", 404, "not_found", false);
    const candidate = await createPreferenceCandidate({
      studentId: id,
      sourceType: body.sourceType === "communication" ? "communication" : "teacher",
      sourceId: typeof body.sourceId === "string" ? body.sourceId : undefined,
      preference: parsed.data,
      evidence: { source: "teacher_manual" },
    });
    return NextResponse.json({ candidate }, { status: 201 });
  } catch (error) {
    return errorResponse(error, "创建沟通偏好候选失败");
  }
}
