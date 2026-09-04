import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseAssessmentPdf } from "@/services/assessment-pdf-service";
import { resolveIntakeStudentIdentity } from "@/services/feedback-intake-service";
import { assertSessionAvailable } from "@/services/academic-scope-recycle-service";
import { ApiError, apiErrorBody } from "@/lib/api-errors";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const sessionCode = String(formData.get("sessionCode") || "").trim();
    const file = formData.get("file");
    if (!sessionCode) {
      return NextResponse.json({ error: "请先选择课次" }, { status: 400 });
    }
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "请选择一份 PDF" }, { status: 400 });
    }
    if (!file.name.toLocaleLowerCase().endsWith(".pdf")) {
      return NextResponse.json({ error: "仅支持 PDF 文件" }, { status: 400 });
    }

    const session = await prisma.classSession.findUnique({
      where: { code: sessionCode },
      select: { id: true, classId: true, semesterId: true },
    });
    if (!session?.classId) {
      return NextResponse.json({ error: "课次不存在或未关联班级" }, { status: 404 });
    }
    await assertSessionAvailable(session.id);
    const students = await prisma.student.findMany({
      where: {
        OR: [
          { enrollments: { some: { semesterId: session.semesterId, classId: session.classId, rosterStatus: "ACTIVE" } } },
          ...(session ? [
            { sessionMetrics: { some: { sessionId: session.id } } },
            { attendances: { some: { sessionId: session.id } } },
            { events: { some: { sessionId: session.id } } },
            { communications: { some: { sessionId: session.id } } },
          ] : []),
        ],
      },
      select: { id: true, name: true, studentId: true },
      orderBy: { studentId: "asc" },
    });
    const parsed = await parseAssessmentPdf(await file.arrayBuffer(), file.name);
    const identity = resolveIntakeStudentIdentity(students, parsed.reportStudentId ?? "", parsed.reportStudentName ?? "");
    if (identity.conflict) {
      return NextResponse.json(
        { error: "PDF 内姓名和听课证号对应不同学生，请人工核对原报告" },
        { status: 409 },
      );
    }
    const matched = identity.match;
    return NextResponse.json({
      fileName: file.name,
      reportStudentName: parsed.reportStudentName,
      reportStudentId: parsed.reportStudentId,
      matchedStudentId: matched?.id ?? "",
      matchedStudentName: matched?.name ?? "",
      matchStatus: matched ? "matched" : "needs_match",
      evidence: {
        ...parsed.evidence,
        sessionCode,
        studentId: matched?.id ?? "",
      },
      warning: identity.usedNameFallback
        ? "报告学号与当前班级不一致，已按当前班唯一姓名匹配"
        : !matched ? "未能自动匹配当前班级学生，请手动选择" : undefined,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json(apiErrorBody(error), { status: error.status });
    }
    const message = error instanceof Error ? error.message : "解析出门测 PDF 失败";
    const status = /缺少 pdftotext/.test(message) ? 503 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
