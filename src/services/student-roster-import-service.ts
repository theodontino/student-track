import * as XLSX from "xlsx";

export interface StudentRosterImportRow {
  rowNumber: number;
  name: string;
  classCode: string;
  className: string;
  studentId: string;
  gender: string;
  subject: string;
  teacher: string;
}

export interface StudentRosterImportClassGroup {
  classCode: string;
  className: string;
  subject: string;
  teacher: string;
  rowCount: number;
  searchText: string;
}

export interface StudentRosterImportAnalysis {
  detectedColumns: Record<string, string>;
  rowCount: number;
  subjects: string[];
  teachers: string[];
  classes: StudentRosterImportClassGroup[];
  defaultSelectedClassCodes: string[];
}

const HEADER_ALIASES = {
  name: ["姓名", "学员姓名", "name"],
  classCode: ["班级", "班级编号", "班级编码", "班级代码", "class", "classcode"],
  className: ["班级名称", "classname"],
  studentId: ["学号", "学员号", "学员编号", "studentid", "student_id", "学籍号"],
  gender: ["性别", "gender"],
  subject: ["科目", "班级对应科目", "学科", "subject"],
  teacher: ["教师", "任课教师", "老师", "teacher"],
} as const;

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeHeader(value: unknown) {
  return clean(value).replace(/^\uFEFF/, "").replace(/\s+/g, "").toLowerCase();
}

function findHeaderIndex(headers: string[], aliases: readonly string[]) {
  const normalizedAliases = new Set(aliases.map(normalizeHeader));
  return headers.findIndex((header) => normalizedAliases.has(header));
}

function headerIndexes(row: unknown[]) {
  const headers = row.map(normalizeHeader);
  return {
    name: findHeaderIndex(headers, HEADER_ALIASES.name),
    classCode: findHeaderIndex(headers, HEADER_ALIASES.classCode),
    className: findHeaderIndex(headers, HEADER_ALIASES.className),
    studentId: findHeaderIndex(headers, HEADER_ALIASES.studentId),
    gender: findHeaderIndex(headers, HEADER_ALIASES.gender),
    subject: findHeaderIndex(headers, HEADER_ALIASES.subject),
    teacher: findHeaderIndex(headers, HEADER_ALIASES.teacher),
  };
}

function displayHeader(row: unknown[], index: number) {
  return index >= 0 ? clean(row[index]) : "";
}

export function parseStudentRosterWorkbook(buffer: ArrayBuffer, extension: string) {
  const workbook = extension === "csv"
    ? XLSX.read(new TextDecoder("utf-8").decode(buffer).replace(/^\uFEFF/, ""), { type: "string" })
    : XLSX.read(buffer, { type: "array", cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return { rows: [] as StudentRosterImportRow[], error: "文件中没有工作表" };
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: false });
  const headerRowIndex = matrix.slice(0, 10).findIndex((row) => {
    const indexes = headerIndexes(row);
    return indexes.name >= 0 && indexes.classCode >= 0 && indexes.studentId >= 0;
  });
  if (headerRowIndex < 0) {
    return { rows: [] as StudentRosterImportRow[], error: "未找到姓名、班级编号和学号列" };
  }
  const headerRow = matrix[headerRowIndex] ?? [];
  const indexes = headerIndexes(headerRow);
  const detectedColumns = Object.fromEntries(Object.entries(indexes)
    .filter(([, index]) => index >= 0)
    .map(([key, index]) => [key, displayHeader(headerRow, index)]));
  const rows = matrix.slice(headerRowIndex + 1).map((sourceRow, index): StudentRosterImportRow => ({
    rowNumber: headerRowIndex + index + 2,
    name: clean(sourceRow[indexes.name]),
    classCode: clean(sourceRow[indexes.classCode]),
    className: indexes.className >= 0 ? clean(sourceRow[indexes.className]) : "",
    studentId: clean(sourceRow[indexes.studentId]),
    gender: indexes.gender >= 0 ? clean(sourceRow[indexes.gender]) : "",
    subject: indexes.subject >= 0 ? clean(sourceRow[indexes.subject]) : "",
    teacher: indexes.teacher >= 0 ? clean(sourceRow[indexes.teacher]) : "",
  })).filter((row) => row.name || row.classCode || row.studentId);
  if (rows.length === 0) return { rows, error: "文件中没有学生数据" };
  return { rows, detectedColumns };
}

export function analyzeStudentRosterRows(
  rows: StudentRosterImportRow[],
  detectedColumns: Record<string, string> = {},
): StudentRosterImportAnalysis {
  const byClass = new Map<string, StudentRosterImportRow[]>();
  for (const row of rows) {
    if (!row.classCode) continue;
    byClass.set(row.classCode, [...(byClass.get(row.classCode) ?? []), row]);
  }
  const classes = [...byClass.entries()].map(([classCode, classRows]) => {
    const first = classRows[0]!;
    return {
      classCode,
      className: first.className,
      subject: first.subject || "未提供科目",
      teacher: first.teacher || "未提供教师",
      rowCount: classRows.length,
      searchText: classRows.flatMap((row) => [row.subject, row.teacher, row.classCode, row.className, row.studentId, row.name]).join(" ").toLowerCase(),
    };
  }).sort((left, right) => (
    left.subject.localeCompare(right.subject, "zh-CN")
    || left.teacher.localeCompare(right.teacher, "zh-CN")
    || left.classCode.localeCompare(right.classCode, "zh-CN")
  ));
  return {
    detectedColumns,
    rowCount: rows.length,
    subjects: [...new Set(classes.map((item) => item.subject))],
    teachers: [...new Set(classes.map((item) => item.teacher))],
    classes,
    defaultSelectedClassCodes: classes.length === 1 ? [classes[0]!.classCode] : [],
  };
}

export function selectStudentRosterRows(rows: StudentRosterImportRow[], classCodes: string[]) {
  if (classCodes.length === 0) return rows;
  const selected = new Set(classCodes);
  return rows.filter((row) => selected.has(row.classCode));
}
