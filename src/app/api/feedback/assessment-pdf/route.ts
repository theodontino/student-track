import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseAssessmentPdf } from "@/services/assessment-pdf-service";

export const runtime = "nodejs";

function fileNameMatches(fileName: string, value: string) {
  return Boolean(value) && fileName.toLocaleLowerCase().includes(value.toLocaleLowerCase());
}

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
      select: { classId: true },
    });
    if (!session?.classId) {
      return NextResponse.json({ error: "课次不存在或未关联班级" }, { status: 404 });
    }
    const students = await prisma.student.findMany({
      where: { classId: session.classId, rosterStatus: "ACTIVE" },
      select: { id: true, name: true, studentId: true },
      orderBy: { studentId: "asc" },
    });
    const parsed = await parseAssessmentPdf(await file.arrayBuffer(), file.name);
    const byStudentId = parsed.reportStudentId
      ? students.find((student) => student.studentId === parsed.reportStudentId)
      : undefined;
    const byName = parsed.reportStudentName
      ? students.find((student) => student.name === parsed.reportStudentName)
      : undefined;
    if (byStudentId && byName && byStudentId.id !== byName.id) {
      return NextResponse.json(
        { error: "PDF 内姓名和听课证号对应不同学生，请人工核对原报告" },
        { status: 409 },
      );
    }

    const fileMatches = students.filter((student) => (
      fileNameMatches(file.name, student.studentId)
      || fileNameMatches(file.name, student.name)
    ));
    const matched = byStudentId ?? byName ?? (fileMatches.length === 1 ? fileMatches[0] : undefined);
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
      warning: !matched
        ? "未能自动匹配当前班级学生，请手动选择"
        : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "解析出门测 PDF 失败";
    const status = /缺少 pdftotext/.test(message) ? 503 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
