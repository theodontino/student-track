import * as XLSX from "xlsx";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ParseResult, ParsedStudent } from "@/lib/parser";
import { completeClassAttendance } from "@/lib/nlAttendance";
import { normalizeDimensionScore } from "@/config/rules";

interface ParsedRosterRow {
  fileName: string;
  sheetName: string;
  rowNumber: number;
  name: string;
  studentId: string;
  classCode: string;
  className: string;
  scoreA: number | null;
  scoreB: number | null;
  scoreC: number | null;
  note: string;
  date: string;
  lessonNumber: string;
}

export interface AssistantRosterImportInput {
  files: Array<{ name: string; buffer: ArrayBuffer }>;
  sessionCode: string;
}

export interface AssistantRosterImportResult {
  draftId: string;
  rawText: string;
  parsedResult: ParseResult;
  reviewResult: null;
  corrections: [];
  warnings: string[];
  matchedRows: number;
  absentStudents: string[];
}

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeHeader(value: unknown) {
  return clean(value).replace(/\s+/g, "");
}

function findHeader(headers: string[], candidates: string[]) {
  return headers.findIndex((header) => candidates.includes(header));
}

function normalizeExcelDate(value: string) {
  const text = value.trim();
  if (!text) return "";
  const slash = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slash) {
    const month = slash[1].padStart(2, "0");
    const day = slash[2].padStart(2, "0");
    const year = slash[3].length === 2 ? `20${slash[3]}` : slash[3];
    return `${year}-${month}-${day}`;
  }
  const dash = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (dash) return `${dash[1]}-${dash[2].padStart(2, "0")}-${dash[3].padStart(2, "0")}`;
  return text;
}

function parseScore(value: unknown) {
  const text = clean(value);
  if (!text || text === "/" || text === "／" || text === "-") return null;
  return normalizeDimensionScore(text);
}

function rowHasUsefulClassroomData(row: ParsedRosterRow) {
  return row.scoreA !== null || row.scoreB !== null || row.scoreC !== null || Boolean(row.note);
}

export function parseAssistantRosterFiles(files: Array<{ name: string; buffer: ArrayBuffer }>) {
  const rows: ParsedRosterRow[] = [];

  for (const file of files) {
    const workbook = XLSX.read(file.buffer, { type: "array", cellDates: true });
    for (const sheetName of workbook.SheetNames) {
      const sheetRows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], {
        header: 1,
        defval: "",
        raw: false,
      });
      if (sheetRows.length < 3) continue;

      const metaHeaders = (sheetRows[0] ?? []).map(normalizeHeader);
      const dateIndex = findHeader(metaHeaders, ["日期"]);
      const lessonIndex = findHeader(metaHeaders, ["课次"]);
      const fileDate = normalizeExcelDate(dateIndex >= 0 ? clean(sheetRows[0][dateIndex + 1]) : "");
      const lessonNumber = lessonIndex >= 0 ? clean(sheetRows[0][lessonIndex + 1]) : "";

      const headers = (sheetRows[1] ?? []).map(normalizeHeader);
      const nameIndex = findHeader(headers, ["姓名"]);
      const studentIdIndex = findHeader(headers, ["听课证号", "听证课号", "学号", "studentId", "student_id", "学籍号"]);
      const classCodeIndex = findHeader(headers, ["班级编号", "班级代码", "classCode", "class", "Class"]);
      const classNameIndex = findHeader(headers, ["班级", "班级名称", "className"]);
      const disciplineIndex = findHeader(headers, ["课堂纪律1-5", "课堂纪律", "纪律"]);
      const homeworkIndex = findHeader(headers, ["课后作业1-5", "课后作业", "作业"]);
      const quizIndex = findHeader(headers, ["出入门测1-5", "出入门测", "测验", "入门测", "出门测"]);
      const noteIndex = headers.findIndex((header) => header.startsWith("备注"));

      if (nameIndex < 0 || classCodeIndex < 0 || disciplineIndex < 0) continue;

      let lastClassCode = "";
      let lastClassName = "";
      for (let rowIndex = 2; rowIndex < sheetRows.length; rowIndex++) {
        const sourceRow = sheetRows[rowIndex];
        const name = clean(sourceRow[nameIndex]);
        const studentId = studentIdIndex >= 0 ? clean(sourceRow[studentIdIndex]) : "";
        const explicitClassCode = clean(sourceRow[classCodeIndex]);
        const explicitClassName = classNameIndex >= 0 ? clean(sourceRow[classNameIndex]) : "";
        if (explicitClassCode) lastClassCode = explicitClassCode;
        if (explicitClassName) lastClassName = explicitClassName;
        if (!name) continue;

        const row: ParsedRosterRow = {
          fileName: file.name,
          sheetName,
          rowNumber: rowIndex + 1,
          name,
          studentId,
          classCode: explicitClassCode || lastClassCode,
          className: explicitClassName || lastClassName,
          scoreA: quizIndex >= 0 ? parseScore(sourceRow[quizIndex]) : null,
          scoreB: disciplineIndex >= 0 ? parseScore(sourceRow[disciplineIndex]) : null,
          scoreC: homeworkIndex >= 0 ? parseScore(sourceRow[homeworkIndex]) : null,
          note: noteIndex >= 0 ? clean(sourceRow[noteIndex]) : "",
          date: fileDate,
          lessonNumber,
        };
        if (row.classCode && rowHasUsefulClassroomData(row)) rows.push(row);
      }
    }
  }

  return rows;
}

function buildEvent(note: string) {
  const normalized = note.trim();
  if (!normalized) return [];
  return [normalized];
}

function buildRawText(input: {
  sessionCode: string;
  sessionDate: string;
  className: string;
  records: ParsedRosterRow[];
  absentStudents: string[];
}) {
  const lines = [
    `助教课堂记录：${input.className} ${input.sessionDate} 课次 ${input.sessionCode}`,
    "评分映射：出入门测=A学习/测验；课堂纪律=B精神/纪律；课后作业=C课后任务。",
    "",
    ...input.records.map((row) => {
      const scores = [`A${row.scoreA ?? "无"}`, `B${row.scoreB ?? "无"}`, `C${row.scoreC ?? "无"}`].join("/");
      return `- ${row.name}(${row.studentId || "无听课证号"}): ${scores}${row.note ? `；${row.note}` : ""}`;
    }),
  ];
  if (input.absentStudents.length > 0) {
    lines.push("", `未出现在助教表中，按缺勤处理：${input.absentStudents.join("、")}`);
  }
  return lines.join("\n");
}

export async function createAssistantRosterDraft(
  prisma: PrismaClient,
  input: AssistantRosterImportInput
): Promise<AssistantRosterImportResult> {
  if (!input.sessionCode) throw new Error("请选择课次");
  if (input.files.length === 0) throw new Error("请上传助教 Excel 文件");

  const session = await prisma.classSession.findUnique({
    where: { code: input.sessionCode },
    include: { class: { select: { id: true, code: true, name: true } } },
  });
  if (!session) throw new Error("课次不存在");
  if (!session.classId || !session.class) throw new Error("该课次未关联班级");

  const roster = await prisma.student.findMany({
    where: {
      OR: [
        { enrollments: { some: { semesterId: session.semesterId, classId: session.classId, rosterStatus: "ACTIVE" } } },
        // A transferred or inactive student with records on this historical
        // session remains eligible for review/import of that session.
        { sessionMetrics: { some: { sessionId: session.id } } },
        { attendances: { some: { sessionId: session.id } } },
        { events: { some: { sessionId: session.id } } },
      ],
    },
    select: { id: true, name: true, studentId: true },
    orderBy: { studentId: "asc" },
  });
  if (roster.length === 0) throw new Error("该班级无学生");

  const rows = parseAssistantRosterFiles(input.files);
  const targetClassName = session.class.name ?? session.class.code;
  const targetRows = rows.filter((row) => (
    row.classCode === session.class?.code || row.className === session.class?.name
  ));
  if (targetRows.length === 0) {
    throw new Error(`未在上传文件中找到 ${targetClassName} 的有效课堂记录`);
  }

  const warnings: string[] = [];
  const dates = Array.from(new Set(targetRows.map((row) => row.date).filter(Boolean)));
  if (dates.length > 0 && !dates.includes(session.date)) {
    warnings.push(`上传表格日期为 ${dates.join("、")}，当前课次日期为 ${session.date}，请确认是否选错课次`);
  }

  const rosterByStudentId = new Map(roster.map((student) => [student.studentId, student]));
  const rosterByName = new Map(roster.map((student) => [student.name, student]));
  const seenStudentIds = new Set<string>();
  const parsedStudents: ParsedStudent[] = [];

  for (const row of targetRows) {
    const matched = (row.studentId ? rosterByStudentId.get(row.studentId) : null) ?? rosterByName.get(row.name);
    if (!matched) {
      warnings.push(`${row.fileName}/${row.sheetName} 第 ${row.rowNumber} 行：${row.name} 不在当前班级名单中，已跳过`);
      continue;
    }
    if (seenStudentIds.has(matched.id)) {
      warnings.push(`${row.fileName}/${row.sheetName} 第 ${row.rowNumber} 行：${matched.name} 重复出现，已保留第一条`);
      continue;
    }
    seenStudentIds.add(matched.id);
    if (row.studentId && matched.studentId !== row.studentId) {
      warnings.push(`${row.fileName}/${row.sheetName} 第 ${row.rowNumber} 行：${row.name} 听课证号与数据库不一致，已按数据库学生 ${matched.name} 处理`);
    }
    parsedStudents.push({
      name: matched.name,
      scores: { A: row.scoreA, B: row.scoreB, C: row.scoreC },
      events: buildEvent(row.note),
      communication: null,
      present: true,
    });
  }
  if (parsedStudents.length === 0) {
    throw new Error(`上传文件中没有学生能匹配到 ${targetClassName} 的班级名单`);
  }

  const initialParsed: ParseResult = {
    students: parsedStudents,
    alert_suggestion: warnings.length > 0 ? warnings.join("；") : "",
  };
  const completed = completeClassAttendance(initialParsed, roster);
  const absentStudents = completed.students.filter((student) => student.present === false).map((student) => student.name);
  const rawText = buildRawText({
    sessionCode: session.code,
    sessionDate: session.date,
    className: targetClassName,
    records: targetRows,
    absentStudents,
  });

  const draft = await prisma.draftRecord.create({
    data: {
      rawText,
      parsedResult: JSON.stringify(completed),
      reviewResult: null,
      status: "pending",
      sessionCode: session.code,
      studentId: completed.students[0] ? rosterByName.get(completed.students[0].name)?.id ?? null : null,
    },
  });

  return {
    draftId: draft.id,
    rawText,
    parsedResult: completed,
    reviewResult: null,
    corrections: [],
    warnings,
    matchedRows: parsedStudents.length,
    absentStudents,
  };
}
