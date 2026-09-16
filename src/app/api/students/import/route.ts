import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logStudentEnrollmentTransfer } from "@/lib/logger";
import { ServiceError } from "@/services/service-error";
import { apiErrorBody, safeApiError } from "@/lib/api-errors";
import { changeStudentEnrollmentClass, requireSemesterId } from "@/services/student-enrollment-service";
import {
  analyzeStudentRosterRows,
  parseStudentRosterWorkbook,
  selectStudentRosterRows,
  type StudentRosterImportRow,
} from "@/services/student-roster-import-service";

function fileFingerprint(buffer: ArrayBuffer) {
  return createHash("sha256").update(Buffer.from(buffer)).digest("hex");
}

function selectedClassCodes(formData: FormData) {
  const raw = formData.get("selectedClassCodes");
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string" && Boolean(value.trim())) : [];
  } catch {
    return [];
  }
}

function selectionKey(classCodes: string[] | null) {
  return classCodes === null ? "all" : JSON.stringify([...new Set(classCodes)].sort());
}

async function buildPreview(rows: StudentRosterImportRow[], semesterId: string) {
  const errors: string[] = [];
  const changes: Array<Record<string, unknown>> = [];
  const seenStudentClasses = new Map<string, string>();
  for (const row of rows) {
    if (!row.name || !row.classCode || !row.studentId || (row.gender && !["男", "女", "未知"].includes(row.gender))) {
      errors.push(`第 ${row.rowNumber} 行：姓名、班级编号和学号必须完整；性别只能是男、女或未知`);
      continue;
    }
    const previousClass = seenStudentClasses.get(row.studentId);
    if (previousClass && previousClass !== row.classCode) errors.push(`第 ${row.rowNumber} 行：学生 ${row.studentId} 在文件中出现多个班级`);
    seenStudentClasses.set(row.studentId, row.classCode);
  }
  const uniqueStudentIds = [...seenStudentClasses.keys()];
  const uniqueClassCodes = [...new Set(rows.map((row) => row.classCode).filter(Boolean))];
  const [students, classes] = await Promise.all([
    prisma.student.findMany({ where: { studentId: { in: uniqueStudentIds } }, include: { enrollments: { where: { semesterId }, include: { class: true } } } }),
    prisma.class.findMany({ where: { semesterId, code: { in: uniqueClassCodes } } }),
  ]);
  const studentById = new Map(students.map((student) => [student.studentId, student]));
  const classByCode = new Map(classes.map((klass) => [klass.code, klass]));
  for (const code of uniqueClassCodes) {
    const source = rows.find((row) => row.classCode === code);
    const existing = classByCode.get(code);
    if (!existing) changes.push({ kind: "class_created", classCode: code, className: source?.className ?? "" });
    else if (!existing.name && source?.className) changes.push({ kind: "class_name_filled", classCode: code, className: source.className });
    else if (existing.name && source?.className && existing.name !== source.className) changes.push({ kind: "class_name_kept", classCode: code, before: existing.name, source: source.className });
  }
  for (const row of rows) {
    if (!row.name || !row.classCode || !row.studentId || (row.gender && !["男", "女", "未知"].includes(row.gender))) continue;
    const student = studentById.get(row.studentId);
    const enrollment = student?.enrollments[0];
    if (!student) {
      changes.push({ kind: "student_created", studentId: row.studentId, name: row.name, gender: row.gender || "未知", classCode: row.classCode });
    } else {
      const nextGender = row.gender || student.gender;
      if (student.name !== row.name || student.gender !== nextGender) changes.push({ kind: "profile_changed", studentId: row.studentId, before: { name: student.name, gender: student.gender }, after: { name: row.name, gender: nextGender } });
      if (enrollment?.class.code !== row.classCode) changes.push({ kind: enrollment ? "transfer" : "enrollment_created", studentId: row.studentId, fromClassCode: enrollment?.class.code ?? null, classCode: row.classCode });
    }
  }
  return { errors, changes, rowCount: rows.length, blocked: errors.length > 0 };
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const semesterRaw = formData.get("semesterId");
    const semesterId = await requireSemesterId(prisma, typeof semesterRaw === "string" ? semesterRaw : undefined);
    if (!(file instanceof File)) return NextResponse.json({ error: "请上传文件" }, { status: 400 });
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (extension !== "xlsx" && extension !== "csv") return NextResponse.json({ error: "仅支持 .xlsx 或 .csv 文件" }, { status: 400 });
    const buffer = await file.arrayBuffer();
    const fingerprint = fileFingerprint(buffer);
    const parsed = parseStudentRosterWorkbook(buffer, extension);
    if (parsed.error) return NextResponse.json({ error: parsed.error, blocked: true, fingerprint }, { status: 400 });
    const mode = String(formData.get("mode") || "preview");
    const selection = selectedClassCodes(formData);
    if (mode === "analyze") {
      return NextResponse.json({ success: true, mode: "analyze", semesterId, fingerprint, ...analyzeStudentRosterRows(parsed.rows, parsed.detectedColumns) });
    }
    if (selection && selection.length === 0) return NextResponse.json({ error: "请至少选择一个班级", blocked: true, fingerprint }, { status: 400 });
    const rows = selectStudentRosterRows(parsed.rows, selection ?? []);
    if (rows.length === 0) return NextResponse.json({ error: "所选范围没有可导入的学生", blocked: true, fingerprint }, { status: 400 });
    const preview = await buildPreview(rows, semesterId);
    const currentSelectionKey = selectionKey(selection);
    if (mode !== "confirm") return NextResponse.json({
      success: !preview.blocked,
      ...(preview.blocked ? { error: "预览存在阻断项，请按明细修正后重试" } : {}),
      mode: "preview",
      semesterId,
      fingerprint,
      selectionKey: currentSelectionKey,
      ...preview,
    }, { status: preview.blocked ? 409 : 200 });
    if (preview.blocked) return NextResponse.json({ error: "预览存在阻断项，未写入", mode: "preview", semesterId, fingerprint, ...preview }, { status: 409 });
    const previewSemesterId = formData.get("previewSemesterId");
    if (previewSemesterId !== null && String(previewSemesterId) !== semesterId) return NextResponse.json({ error: "所选学期已变化，请重新预览", code: "semester_mismatch" }, { status: 409 });
    if (String(formData.get("previewFingerprint") || "") !== fingerprint) return NextResponse.json({ error: "文件已变化，请重新预览", code: "fingerprint_mismatch" }, { status: 409 });
    if (String(formData.get("previewSelectionKey") || "") !== currentSelectionKey) return NextResponse.json({ error: "所选班级已变化，请重新预览", code: "selection_mismatch" }, { status: 409 });

    const result = await prisma.$transaction(async (tx) => {
      const classByCode = new Map<string, { id: string }>();
      for (const code of [...new Set(rows.map((row) => row.classCode))]) {
        const source = rows.find((row) => row.classCode === code);
        const existing = await tx.class.findUnique({ where: { semesterId_code: { semesterId, code } }, select: { id: true } });
        if (existing && source?.className) {
          await tx.class.updateMany({
            where: { id: existing.id, OR: [{ name: null }, { name: "" }] },
            data: { name: source.className },
          });
        }
        const klass = existing ?? await tx.class.create({ data: { semesterId, code, name: source?.className || null }, select: { id: true } });
        classByCode.set(code, klass);
      }
      let studentsCreated = 0;
      let enrollmentsUpdated = 0;
      const transfers: Array<{
        studentId: string;
        studentName: string;
        previousClass: { id: string; code: string; name: string | null };
        currentClass: { id: string; code: string; name: string | null };
      }> = [];
      for (const row of rows) {
        const klass = classByCode.get(row.classCode)!;
        const existing = await tx.student.findUnique({ where: { studentId: row.studentId }, select: { id: true, gender: true } });
        const student = existing
          ? await tx.student.update({ where: { id: existing.id }, data: { name: row.name, ...(row.gender ? { gender: row.gender } : {}) }, select: { id: true } })
          : await tx.student.create({ data: { name: row.name, studentId: row.studentId, gender: row.gender || "未知" }, select: { id: true } });
        if (!existing) studentsCreated++;
        const transition = await changeStudentEnrollmentClass(
          tx,
          { studentId: student.id, semesterId, classId: klass.id },
          { createIfMissing: true, activateExisting: true },
        );
        if (transition.changed && transition.previousClass) {
          transfers.push({
            studentId: student.id,
            studentName: row.name,
            previousClass: transition.previousClass,
            currentClass: transition.enrollment.class,
          });
        }
        enrollmentsUpdated++;
      }
      return { summary: { studentsCreated, enrollmentsUpdated, classesTouched: classByCode.size }, transfers };
    });
    for (const transfer of result.transfers) {
      await logStudentEnrollmentTransfer({ semesterId, ...transfer });
    }
    return NextResponse.json({ success: true, mode: "committed", semesterId, fingerprint, total: rows.length, ...result.summary });
  } catch (error) {
    console.error("[/api/students/import] error:", error);
    if (error instanceof ServiceError && error.status < 500) return NextResponse.json({ error: error.message }, { status: error.status });
    const failure = safeApiError(error, "导入失败，请检查文件格式", "api.student_import");
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
  }
}
