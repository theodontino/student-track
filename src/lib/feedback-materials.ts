import {
  AssessmentImportItemSchema,
  LessonFeedbackMaterialSchema,
  StudentAssessmentEvidenceSchema,
} from "@/lib/contracts/feedback";
import { containsRecipientPlaceholder } from "@/lib/feedback-text-safety";

export interface LessonFeedbackMaterial {
  version: 1;
  sessionCode?: string;
  lessonSummary?: string;
  lessonSummarySourceHash?: string;
  lessonSummaryStatus?: "model" | "fallback";
  groupFeedbackRaw: string;
  assessmentBriefRaw: string;
  lessonTitle: string;
  classroomContent: string[];
  classroomFocus: string[];
  classroomExplanation: string[];
  homework: string[];
  assessmentFocus: string[];
  correctionAdvice: string[];
  otherNotes: string[];
}

export interface AssessmentKnowledgePoint {
  name: string;
  questionCount: number;
  correctRate: number;
  cohortAverageRate: number | null;
}

export interface AssessmentWrongItem {
  questionNumber: string;
  studentAnswer: string;
  correctAnswer: string;
  knowledgePoints: string[];
}

export interface StudentAssessmentEvidence {
  sessionCode?: string;
  studentId?: string;
  reportTitle: string;
  reportDate: string;
  totalQuestions: number;
  correctRate: number;
  cohortAverageRate: number | null;
  knowledgePoints: AssessmentKnowledgePoint[];
  wrongItems: AssessmentWrongItem[];
  similarPracticeCount: number;
}

export type AssessmentImportStatus =
  | "parsing"
  | "matched"
  | "needs_match"
  | "confirmed"
  | "error";

export interface AssessmentImportItem {
  id: string;
  fileName: string;
  status: AssessmentImportStatus;
  reportStudentName: string;
  reportStudentId: string;
  matchedStudentId: string;
  matchedStudentName: string;
  evidence: StudentAssessmentEvidence | null;
  error: string;
}

export interface AssessmentPdfParseResponse {
  fileName: string;
  reportStudentName: string;
  reportStudentId: string;
  matchedStudentId: string;
  matchedStudentName: string;
  matchStatus: "matched" | "needs_match";
  evidence: StudentAssessmentEvidence;
  warning?: string;
}

export interface AssessmentRosterIdentity {
  id: string;
  name: string;
  studentId?: string;
}

export interface AssessmentFolderPlan {
  totalPdfCount: number;
  matched: Array<{
    fileIndex: number;
    fileName: string;
    studentId: string;
    studentName: string;
  }>;
  missingStudents: Array<{ id: string; name: string }>;
  ignoredFileCount: number;
  duplicateStudents: string[];
  folderName: string;
}

const EMPTY_MATERIAL: LessonFeedbackMaterial = {
  version: 1,
  groupFeedbackRaw: "",
  assessmentBriefRaw: "",
  lessonTitle: "",
  classroomContent: [],
  classroomFocus: [],
  classroomExplanation: [],
  homework: [],
  assessmentFocus: [],
  correctionAdvice: [],
  otherNotes: [],
};

const GROUP_HEADINGS = new Map<string, keyof Pick<
  LessonFeedbackMaterial,
  "classroomContent" | "classroomFocus" | "classroomExplanation" | "homework"
>>([
  ["课堂内容", "classroomContent"],
  ["课堂重点", "classroomFocus"],
  ["课堂说明", "classroomExplanation"],
  ["课后作业", "homework"],
]);

function cleanLine(value: string) {
  return value
    .replace(/^[\s\uFEFF]+|[\s\uFEFF]+$/g, "")
    .replace(/^[👉🎁⭐⏰✍🤗📌📍]+\s*/u, "")
    .trim();
}

function cleanListItem(value: string) {
  return cleanLine(value)
    .replace(/^[【[]|[】\]]$/g, "")
    .replace(/^\d+[.、）)]\s*/, "")
    .replace(/^[-•·]\s*/, "")
    .trim();
}

function sectionHeading(value: string) {
  return cleanLine(value)
    .replace(/^【|】$/g, "")
    .replace(/[：:]\s*$/, "")
    .trim();
}

function compactUnique(values: string[], limit = 20) {
  return [...new Set(values
    .map(cleanListItem)
    .filter((value) => (
      Boolean(value)
      && !containsRecipientPlaceholder(value)
      && !/(?:妈妈|爸爸|家长)\s*(?:您好|你好|好)[，,。！!：:]?/u.test(value)
    )))].slice(0, limit);
}

function parseGroupFeedback(raw: string) {
  const result = {
    lessonTitle: "",
    classroomContent: [] as string[],
    classroomFocus: [] as string[],
    classroomExplanation: [] as string[],
    homework: [] as string[],
    otherNotes: [] as string[],
  };
  let target: keyof Pick<
    LessonFeedbackMaterial,
    "classroomContent" | "classroomFocus" | "classroomExplanation" | "homework"
  > | null = null;

  for (const sourceLine of raw.split(/\r?\n/)) {
    const line = cleanLine(sourceLine);
    if (!line) continue;
    const titleMatch = line.match(/[《「](.+?)[》」]/);
    if (!result.lessonTitle && titleMatch?.[1]) result.lessonTitle = titleMatch[1].trim();
    if (titleMatch && /群反馈/.test(line)) continue;

    const heading = sectionHeading(line);
    const foundTarget = GROUP_HEADINGS.get(heading);
    if (foundTarget) {
      target = foundTarget;
      continue;
    }

    if (target) result[target].push(line);
    else if (!/^(各位家长好|群反馈)/.test(line)) result.otherNotes.push(line);
  }

  result.classroomContent = compactUnique(result.classroomContent);
  result.classroomFocus = compactUnique(result.classroomFocus);
  result.classroomExplanation = compactUnique(result.classroomExplanation, 8);
  result.homework = compactUnique(result.homework);
  result.otherNotes = compactUnique(result.otherNotes, 8);
  return result;
}

function parseAssessmentBrief(raw: string) {
  const assessmentFocus: string[] = [];
  const correctionAdvice: string[] = [];
  const otherNotes: string[] = [];
  let readingFocus = false;

  for (const sourceLine of raw.split(/\r?\n/)) {
    const originalLine = cleanLine(sourceLine);
    const line = originalLine.replace(
      /^孩子这次(?:出门测)?(?:存在一定错误|有一定错误|表现(?:较好|良好|不错)|完成(?:较好|不错))[，,。；;]?\s*/u,
      "",
    );
    if (!line) continue;
    if (/主要考察|考查内容|考察内容/.test(line)) {
      readingFocus = true;
      continue;
    }
    if (/订正|讲解视频|答疑|复习|巩固|改错/.test(line)) {
      correctionAdvice.push(line);
      readingFocus = false;
      continue;
    }
    if (/^孩子这次.*(?:错误|正确|表现|完成)/.test(originalLine)) {
      // This is a per-student judgment in a reusable template, not evidence.
      continue;
    }
    if (readingFocus || /^\d+[.、）)]/.test(line)) assessmentFocus.push(line);
    else if (!/^(群发内容|.+家长您好|这是孩子的出门测报告|请查收)/.test(line)) {
      otherNotes.push(line);
    }
  }

  return {
    assessmentFocus: compactUnique(assessmentFocus),
    correctionAdvice: compactUnique(correctionAdvice),
    otherNotes: compactUnique(otherNotes, 8),
  };
}

export function createEmptyLessonFeedbackMaterial(sessionCode = ""): LessonFeedbackMaterial {
  return { ...EMPTY_MATERIAL, sessionCode };
}

export function parseLessonFeedbackMaterial(
  groupFeedbackRaw: string,
  assessmentBriefRaw: string,
  sessionCode = "",
): LessonFeedbackMaterial {
  const group = parseGroupFeedback(groupFeedbackRaw);
  const assessment = parseAssessmentBrief(assessmentBriefRaw);
  return {
    version: 1,
    sessionCode,
    groupFeedbackRaw: groupFeedbackRaw.trim(),
    assessmentBriefRaw: assessmentBriefRaw.trim(),
    lessonTitle: group.lessonTitle,
    classroomContent: group.classroomContent,
    classroomFocus: group.classroomFocus,
    classroomExplanation: group.classroomExplanation,
    homework: group.homework,
    assessmentFocus: assessment.assessmentFocus,
    correctionAdvice: assessment.correctionAdvice,
    otherNotes: compactUnique([...group.otherNotes, ...assessment.otherNotes], 12),
  };
}

export function isLessonFeedbackMaterial(value: unknown): value is LessonFeedbackMaterial {
  return LessonFeedbackMaterialSchema.safeParse(value).success;
}

export function isStudentAssessmentEvidence(value: unknown): value is StudentAssessmentEvidence {
  return StudentAssessmentEvidenceSchema.safeParse(value).success;
}

export function isAssessmentImportItem(value: unknown): value is AssessmentImportItem {
  return AssessmentImportItemSchema.safeParse(value).success;
}

export function assessmentEvidenceByStudent(
  items: AssessmentImportItem[],
): Record<string, StudentAssessmentEvidence> {
  return Object.fromEntries(items
    .filter((item) => (
      item.status === "confirmed"
      && Boolean(item.matchedStudentId)
      && item.evidence !== null
    ))
    .map((item) => [item.matchedStudentId, item.evidence as StudentAssessmentEvidence]));
}

function comparableIdentity(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, "");
}

function folderNameFrom(files: Array<{ name: string; webkitRelativePath?: string }>) {
  const relativePath = files.find((file) => file.webkitRelativePath)?.webkitRelativePath ?? "";
  return relativePath.split("/").filter(Boolean)[0] ?? "";
}

export function planAssessmentFolderImport(
  files: Array<{ name: string; webkitRelativePath?: string }>,
  roster: AssessmentRosterIdentity[],
): AssessmentFolderPlan {
  const pdfs = files
    .map((file, fileIndex) => ({ file, fileIndex }))
    .filter(({ file }) => file.name.toLocaleLowerCase().endsWith(".pdf"));
  const matchedStudentIds = new Set<string>();
  const duplicateStudentIds = new Set<string>();
  const matched: AssessmentFolderPlan["matched"] = [];

  for (const { file, fileIndex } of pdfs) {
    const fileIdentity = comparableIdentity(file.name);
    const idMatches = roster.filter((student) => (
      Boolean(student.studentId)
      && fileIdentity.includes(comparableIdentity(student.studentId ?? ""))
    ));
    const nameMatches = roster.filter((student) => (
      Boolean(student.name)
      && fileIdentity.includes(comparableIdentity(student.name))
    ));
    const candidates = idMatches.length === 1
      ? idMatches
      : nameMatches.sort((left, right) => right.name.length - left.name.length);
    if (!candidates.length) continue;
    const longestNameLength = candidates[0].name.length;
    const equallySpecific = candidates.filter((student) => student.name.length === longestNameLength);
    if (idMatches.length !== 1 && equallySpecific.length !== 1) continue;
    const student = idMatches.length === 1 ? idMatches[0] : equallySpecific[0];
    if (matchedStudentIds.has(student.id)) {
      duplicateStudentIds.add(student.id);
      continue;
    }
    matchedStudentIds.add(student.id);
    matched.push({
      fileIndex,
      fileName: file.name,
      studentId: student.id,
      studentName: student.name,
    });
  }

  return {
    totalPdfCount: pdfs.length,
    matched,
    missingStudents: roster
      .filter((student) => !matchedStudentIds.has(student.id))
      .map((student) => ({ id: student.id, name: student.name })),
    ignoredFileCount: pdfs.length - matched.length,
    duplicateStudents: roster
      .filter((student) => duplicateStudentIds.has(student.id))
      .map((student) => student.name),
    folderName: folderNameFrom(files),
  };
}

export function lessonMaterialHasContent(material: LessonFeedbackMaterial) {
  return Boolean(
    material.groupFeedbackRaw
    || material.assessmentBriefRaw
    || material.lessonTitle
    || material.classroomContent.length
    || material.classroomFocus.length
    || material.classroomExplanation.length
    || material.homework.length
    || material.assessmentFocus.length
    || material.correctionAdvice.length
    || material.otherNotes.length
  );
}

export function lessonMaterialSummarySource(material: LessonFeedbackMaterial) {
  return {
    sessionCode: material.sessionCode ?? "",
    lessonTitle: material.lessonTitle,
    classroomContent: material.classroomContent,
    classroomFocus: material.classroomFocus,
    classroomExplanation: material.classroomExplanation,
    homework: material.homework,
    assessmentFocus: material.assessmentFocus,
    correctionAdvice: material.correctionAdvice,
    otherNotes: material.otherNotes,
  };
}

function promptList(label: string, values: string[]) {
  return values.length ? `${label}：${values.join("；")}` : "";
}

export function fallbackLessonSummary(material: LessonFeedbackMaterial) {
  return [
    material.lessonTitle ? `本课主题为${material.lessonTitle}。` : "",
    promptList("课堂内容", material.classroomContent),
    promptList("课堂重点", material.classroomFocus),
    promptList("课堂讲解与处理", material.classroomExplanation),
    promptList("课后任务", material.homework),
    promptList("出门测考查范围", material.assessmentFocus),
    promptList("统一订正说明", material.correctionAdvice),
    promptList("其他课程说明", material.otherNotes),
  ].filter(Boolean).join("\n").slice(0, 2000);
}

export function lessonMaterialPrompt(material: LessonFeedbackMaterial | null | undefined) {
  if (!material || !lessonMaterialHasContent(material)) return "";
  const summary = material.lessonSummary?.trim() || fallbackLessonSummary(material);
  return [
    "【本班本课课程摘要（每班整理一次，不是个人证据）】",
    material.sessionCode ? `绑定课次：${material.sessionCode}` : "",
    summary,
    "使用边界：本区只帮助理解本节课讲授内容、知识组织和统一考查结构。它不能证明该学生已经掌握、失误或完成统一任务；学生结论必须来自该生个人证据。",
  ].filter(Boolean).join("\n");
}

export function assessmentEvidencePrompt(evidence: StudentAssessmentEvidence | null | undefined) {
  if (!evidence) return "";
  const weakPoints = evidence.knowledgePoints
    .filter((item) => item.correctRate < 100)
    .map((item) => `${item.name} ${item.questionCount}题/正确率${item.correctRate}%${item.cohortAverageRate === null ? "" : `/同期均值${item.cohortAverageRate}%`}`);
  const wrongItems = evidence.wrongItems.map((item) => (
    `第${item.questionNumber}题本人答${item.studentAnswer || "未提取"}、正确答案${item.correctAnswer || "未提取"}`
    + `${item.knowledgePoints.length ? `，涉及${item.knowledgePoints.join("、")}` : ""}`
  ));
  const wrongQuestionNumbers = evidence.wrongItems
    .map((item) => `第${item.questionNumber}题`)
    .join("、");
  const actionPlan = evidence.wrongItems.length
    ? [
      `先不看答案重做${wrongQuestionNumbers}，每题写一句判断依据`,
      evidence.similarPracticeCount > 0
        ? `再完成报告附带的${evidence.similarPracticeCount}道相似练习`
        : "",
      "仍不能独立完成时，再看讲解或向老师提问",
    ].filter(Boolean).join("；")
    : "";
  return [
    "【该生出门测客观证据】",
    evidence.sessionCode ? `绑定课次：${evidence.sessionCode}` : "",
    evidence.studentId ? `绑定学生ID：${evidence.studentId}` : "",
    `${evidence.reportDate || "日期未知"} ${evidence.reportTitle || "出门测"}：共${evidence.totalQuestions}题，正确率${evidence.correctRate}%${evidence.cohortAverageRate === null ? "" : `，同期均值${evidence.cohortAverageRate}%`}。`,
    weakPoints.length ? `尚未全部通过的知识点：${weakPoints.join("；")}` : "报告列出的知识点本次均已通过。",
    wrongItems.length ? `错题：${wrongItems.join("；")}` : "报告未列出错题。",
    evidence.similarPracticeCount > 0 ? `报告附带${evidence.similarPracticeCount}道相似练习。` : "",
    actionPlan ? `可执行课后任务（这是建议，不是已经完成的事实）：${actionPlan}。` : "",
    "证据边界：单次报告只能描述本次答题，不得据此推断长期能力或人格特征。",
  ].filter(Boolean).join("\n");
}
