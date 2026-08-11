import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logStudentEnrollmentTransfer } from "@/lib/logger";
import * as XLSX from "xlsx";
import { ServiceError } from "@/services/service-error";
import { changeStudentEnrollmentClass, requireSemesterId } from "@/services/student-enrollment-service";

interface RosterRow {
  rowNumber: number;
  name: string;
  classCode: string;
  studentId: string;
  gender: string;
}

function fileFingerprint(buffer: ArrayBuffer) {
  return createHash("sha256").update(Buffer.from(buffer)).digest("hex");
}

function parseRows(buffer: ArrayBuffer, extension: string): { rows: RosterRow[]; error?: string } {
  const workbook = extension === "csv"
    ? XLSX.read(new TextDecoder("utf-8").decode(buffer).replace(/^\uFEFF/, ""), { type: "string" })
    : XLSX.read(buffer, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return { rows: [], error: "文件中没有工作表" };
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  if (rawRows.length === 0) return { rows: [], error: "文件中没有数据" };
  const headers = Object.keys(rawRows[0]);
  const findHeader = (candidates: string[]) => headers.find((header) => candidates.includes(header.trim())) || "";
  const nameKey = findHeader(["姓名", "name", "Name"]);
  const classKey = findHeader(["班级", "班级编号", "class", "Class", "classCode"]);
  const studentIdKey = findHeader(["学号", "studentId", "student_id", "学籍号"]);
  const genderKey = findHeader(["性别", "gender", "Gender"]);
  if (!nameKey || !classKey || !studentIdKey) return { rows: [], error: `${!nameKey ? "姓名, " : ""}${!classKey ? "班级编号, " : ""}${!studentIdKey ? "学号" : ""}`.replace(/, $/, "") + "列为必填" };
  const rows: RosterRow[] = rawRows.map((raw, index) => ({
    rowNumber: index + 2,
    name: String(raw[nameKey] ?? "").trim(),
    classCode: String(raw[classKey] ?? "").trim(),
    studentId: String(raw[studentIdKey] ?? "").trim(),
    gender: genderKey ? String(raw[genderKey] ?? "").trim() : "男",
  }));
  return { rows };
}

async function buildPreview(rows: RosterRow[], semesterId: string) {
  const errors: string[] = [];
  const changes: Array<Record<string, unknown>> = [];
  const seenStudentClasses = new Map<string, string>();
  for (const row of rows) {
    if (!row.name || !row.classCode || !row.studentId || !["男", "女"].includes(row.gender)) {
      errors.push(`第 ${row.rowNumber} 行：姓名、班级编号、学号、性别必须完整且有效`);
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
  for (const code of uniqueClassCodes) if (!classByCode.has(code)) changes.push({ kind: "class_created", classCode: code });
  for (const row of rows) {
    if (!row.name || !row.classCode || !row.studentId || !["男", "女"].includes(row.gender)) continue;
    const student = studentById.get(row.studentId);
    const enrollment = student?.enrollments[0];
    if (!student) {
      changes.push({ kind: "student_created", studentId: row.studentId, name: row.name, classCode: row.classCode });
    } else {
      if (student.name !== row.name || student.gender !== row.gender) changes.push({ kind: "profile_changed", studentId: row.studentId, before: { name: student.name, gender: student.gender }, after: { name: row.name, gender: row.gender } });
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
    const parsed = parseRows(buffer, extension);
    if (parsed.error) return NextResponse.json({ error: parsed.error, blocked: true, fingerprint }, { status: 400 });
    const preview = await buildPreview(parsed.rows, semesterId);
    const mode = String(formData.get("mode") || "preview");
    if (mode !== "confirm") return NextResponse.json({ success: !preview.blocked, mode: "preview", semesterId, fingerprint, ...preview }, { status: preview.blocked ? 409 : 200 });
    if (preview.blocked) return NextResponse.json({ error: "预览存在阻断项，未写入", mode: "preview", semesterId, fingerprint, ...preview }, { status: 409 });
    const previewSemesterId = formData.get("previewSemesterId");
    if (previewSemesterId !== null && String(previewSemesterId) !== semesterId) return NextResponse.json({ error: "所选学期已变化，请重新预览", code: "semester_mismatch" }, { status: 409 });
    if (String(formData.get("previewFingerprint") || "") !== fingerprint) return NextResponse.json({ error: "文件已变化，请重新预览", code: "fingerprint_mismatch" }, { status: 409 });

    const result = await prisma.$transaction(async (tx) => {
      const classByCode = new Map<string, { id: string }>();
      for (const code of [...new Set(parsed.rows.map((row) => row.classCode))]) {
        const existing = await tx.class.findUnique({ where: { semesterId_code: { semesterId, code } }, select: { id: true } });
        const klass = existing ?? await tx.class.create({ data: { semesterId, code }, select: { id: true } });
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
      for (const row of parsed.rows) {
        const klass = classByCode.get(row.classCode)!;
        const existing = await tx.student.findUnique({ where: { studentId: row.studentId }, select: { id: true } });
        const student = existing
          ? await tx.student.update({ where: { id: existing.id }, data: { name: row.name, gender: row.gender }, select: { id: true } })
          : await tx.student.create({ data: { name: row.name, studentId: row.studentId, gender: row.gender }, select: { id: true } });
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
    return NextResponse.json({ success: true, mode: "committed", semesterId, fingerprint, total: parsed.rows.length, ...result.summary });
  } catch (error) {
    console.error("[/api/students/import] error:", error);
    if (error instanceof ServiceError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "导入失败，请检查文件格式" }, { status: 500 });
  }
}
