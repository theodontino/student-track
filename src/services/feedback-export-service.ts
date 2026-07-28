import * as XLSX from "xlsx";
import type { PrismaClient } from "@/generated/prisma/client";
import type { FeedbackSections } from "@/lib/feedback-sections";
import type { StudentRisk } from "@/services/student-risk-service";

export interface FeedbackExportCard {
  id: string;
  name: string;
  feedback: string;
  draftFeedback?: string;
  reviewStatus?: "passed" | "revised" | "needs_review" | "edited";
  reviewIssues?: string[];
  sections?: FeedbackSections;
  contextPreview?: { communications?: string[] };
}

function average(values: number[]) {
  if (values.length === 0) return "";
  return +(values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1);
}

function alertText(risks: StudentRisk[]) {
  return risks.flatMap((risk) => {
    const publicSignals = risk.signals.filter((signal) => signal.type !== "qualitative-feedback");
    const publicLevel = publicSignals.length >= 2 ? "警告" : "关注";
    return publicSignals.map((signal) => `${publicLevel}：${signal.label}（${signal.evidence}）`);
  }).join("；");
}

function reviewStatusText(status: FeedbackExportCard["reviewStatus"]) {
  if (status === "passed") return "AI 审核通过";
  if (status === "revised") return "AI 已修订";
  if (status === "edited") return "教师已修改";
  if (status === "needs_review") return "需要人工确认";
  return "未标记";
}

function textBar(value: number, total: number, slots = 16) {
  if (total <= 0) return "";
  const filled = Math.max(0, Math.min(slots, Math.round((value / total) * slots)));
  return `${"█".repeat(filled)}${"░".repeat(slots - filled)}`;
}

function scoreBar(value: number | "", maximum = 5) {
  return value === "" ? "" : textBar(value, maximum, 10);
}

/** Builds the standard post-class feedback workbook from persisted session data. */
export async function buildFeedbackExportWorkbook(
  prisma: PrismaClient,
  sessionCode: string,
  cards: FeedbackExportCard[],
  risks: StudentRisk[],
) {
  const session = await prisma.classSession.findUnique({
    where: { code: sessionCode },
    select: { id: true, classId: true, date: true, semesterNumber: true },
  });
  if (!session) throw new Error("课次不存在");
  if (!session.classId) throw new Error("该课次未关联班级");

  const studentIds = cards.map((card) => card.id);
  const previousSessions = await prisma.classSession.findMany({
    where: {
      classId: session.classId,
      OR: [
        { date: { lt: session.date } },
        { date: session.date, semesterNumber: { lt: session.semesterNumber } },
      ],
    },
    select: { id: true },
    orderBy: [{ date: "desc" }, { semesterNumber: "desc" }, { createdAt: "desc" }],
  });

  const [currentMetrics, previousMetrics] = await Promise.all([
    prisma.sessionMetric.findMany({
      where: { sessionId: session.id, studentId: { in: studentIds } },
    }),
    prisma.sessionMetric.findMany({
      where: { sessionId: { in: previousSessions.map((item) => item.id) }, studentId: { in: studentIds } },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    }),
  ]);

  const currentByStudent = new Map(currentMetrics.map((metric) => [metric.studentId, metric]));
  const previousByStudent = new Map<string, typeof previousMetrics[number]>();
  for (const metric of previousMetrics) {
    if (!previousByStudent.has(metric.studentId)) previousByStudent.set(metric.studentId, metric);
  }
  const risksByStudent = new Map<string, StudentRisk[]>();
  for (const risk of risks) {
    risksByStudent.set(risk.studentId, [...(risksByStudent.get(risk.studentId) ?? []), risk]);
  }

  const rows = cards.map((card) => {
    const current = currentByStudent.get(card.id);
    const previous = previousByStudent.get(card.id);
    return {
      姓名: card.name,
      本次学习测验: current?.scoreA ?? "",
      本次精神纪律: current?.scoreB ?? "",
      本次课后任务: current?.scoreC ?? "",
      上次学习测验: previous?.scoreA ?? "",
      上次精神纪律: previous?.scoreB ?? "",
      上次课后任务: previous?.scoreC ?? "",
      参考家校背景: card.contextPreview?.communications?.join("；") ?? "",
      预警: alertText(risksByStudent.get(card.id) ?? []),
      最终反馈: card.feedback,
    };
  });

  rows.push({
    姓名: "班级均分",
    本次学习测验: average(currentMetrics.map((metric) => metric.scoreA)),
    本次精神纪律: average(currentMetrics.map((metric) => metric.scoreB)),
    本次课后任务: average(currentMetrics.map((metric) => metric.scoreC)),
    上次学习测验: average([...previousByStudent.values()].map((metric) => metric.scoreA)),
    上次精神纪律: average([...previousByStudent.values()].map((metric) => metric.scoreB)),
    上次课后任务: average([...previousByStudent.values()].map((metric) => metric.scoreC)),
    参考家校背景: "",
    预警: "",
    最终反馈: "",
  });

  const worksheet = XLSX.utils.json_to_sheet(rows);
  worksheet["!cols"] = [
    { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 14 },
    { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 48 },
    { wch: 40 }, { wch: 64 },
  ];
  worksheet["!autofilter"] = { ref: `A1:J${rows.length + 1}` };
  worksheet["!freeze"] = { xSplit: 1, ySplit: 1 };

  // 这张表只保留教师复核时真正需要逐行对照的五项内容；与可直接发送的
  // 家长反馈分开存放，但仍在同一个工作簿中。
  const teacherRows = cards.map((card) => ({
    姓名: card.name,
    本次事实: card.sections?.currentFact.content ?? "",
    背景基线: card.sections?.backgroundBaseline?.content ?? "",
    "建议反馈文本（模型/已编辑）": card.feedback,
    内部分析草稿: card.draftFeedback ?? "",
  }));
  const teacherWorksheet = XLSX.utils.json_to_sheet(teacherRows);
  teacherWorksheet["!cols"] = [
    { wch: 12 }, { wch: 48 }, { wch: 48 }, { wch: 68 }, { wch: 68 },
  ];
  teacherWorksheet["!autofilter"] = { ref: `A1:E${teacherRows.length + 1}` };
  teacherWorksheet["!freeze"] = { xSplit: 1, ySplit: 1 };

  const statusCounts = new Map<string, number>();
  for (const card of cards) {
    const label = reviewStatusText(card.reviewStatus);
    statusCounts.set(label, (statusCounts.get(label) ?? 0) + 1);
  }
  const currentAverages = [
    ["学习测验", average(currentMetrics.map((metric) => metric.scoreA))],
    ["精神纪律", average(currentMetrics.map((metric) => metric.scoreB))],
    ["课后任务", average(currentMetrics.map((metric) => metric.scoreC))],
  ] as const;
  const overviewRows: Array<Array<string | number>> = [
    ["课后反馈导出概览"],
    [`课次：${sessionCode} · 共 ${cards.length} 名学生`],
    [],
    ["反馈文本状态", "人数", "可视化"],
    ...["AI 审核通过", "AI 已修订", "教师已修改", "需要人工确认", "未标记"].map((label) => {
      const count = statusCounts.get(label) ?? 0;
      return [label, count, textBar(count, cards.length)];
    }),
    [],
    ["本次评分概览", "班级均分", "五分刻度"],
    ...currentAverages.map(([label, value]) => {
      const numeric = typeof value === "number" ? value : "";
      return [label, value, scoreBar(numeric)];
    }),
  ];
  const overviewWorksheet = XLSX.utils.aoa_to_sheet(overviewRows);
  overviewWorksheet["!cols"] = [{ wch: 20 }, { wch: 14 }, { wch: 28 }];
  overviewWorksheet["!freeze"] = { ySplit: 3 };

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "课后反馈");
  XLSX.utils.book_append_sheet(workbook, teacherWorksheet, "教师内部研判");
  XLSX.utils.book_append_sheet(workbook, overviewWorksheet, "导出概览");
  return new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }));
}
