import * as XLSX from "xlsx";
import type { PrismaClient } from "@/generated/prisma/client";
import type { FeedbackSections } from "@/lib/feedback-sections";
import type { StudentRisk } from "@/services/student-risk-service";
import { createHash } from "node:crypto";
import { ApiError } from "@/lib/api-errors";
import { validateFeedbackPlanAttachments } from "@/services/feedback-plan-service";

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

export const WECOM_DRAFT_PACKAGE_CONTRACT_VERSION = "student-track.wecom-draft-package.v1";

export interface WeComDraftPackageV1 {
  contractVersion: typeof WECOM_DRAFT_PACKAGE_CONTRACT_VERSION;
  packageId: string;
  createdAt: string;
  manifestSha256: string;
  plan: {
    id: string;
    revision: number;
    type: string;
  };
  items: Array<{
    itemId: string;
    studentRef: {
      id: string;
      businessId: string;
      displayName: string;
    };
    text: string;
    textSha256: string;
    approvedAt: string;
  }>;
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

/** Builds the versioned FeedbackPlan workbook using only approved items. */
export async function buildFeedbackPlanExportWorkbook(
  prisma: PrismaClient,
  planId: string,
  mode: "complete" | "approved_only" = "complete",
  options: { allowRepeat?: boolean } = {},
) {
  await validateFeedbackPlanAttachments(planId, prisma);
  const plan = await prisma.feedbackPlan.findUnique({
    where: { id: planId },
    include: {
      items: { include: { student: { select: { name: true, studentId: true } }, tasks: true, attachments: true } },
      tasks: { include: { student: { select: { name: true } }, dueSession: { select: { code: true, date: true } } } },
      attachments: true,
      exportRuns: { orderBy: { createdAt: "desc" }, take: 20 },
    },
  });
  if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);
  const pendingCount = plan.items.filter((item) => item.status !== "approved" && item.status !== "exported").length;
  if (mode === "complete" && pendingCount > 0) throw new ApiError(`还有 ${pendingCount} 条反馈未批准`, 409, "conflict", false);
  const approvedItems = plan.items.filter((item) => (item.status === "approved" || item.status === "exported") && item.finalText?.trim());
  let items = mode === "approved_only"
    ? approvedItems.filter((item) => item.status === "approved")
    : approvedItems;
  const fallbackManifest = approvedItems.map((item) => ({ itemId: item.id, finalTextHash: item.finalTextHash ?? "" }));
  const normalizedManifestHash = (value: string) => {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!Array.isArray(parsed)) return "";
      const normalized = parsed
        .filter((entry): entry is { itemId?: unknown; finalTextHash?: unknown } => Boolean(entry && typeof entry === "object"))
        .map((entry) => ({ itemId: String(entry.itemId ?? ""), finalTextHash: String(entry.finalTextHash ?? "") }))
        .filter((entry) => entry.itemId);
      return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
    } catch {
      return "";
    }
  };
  const fallbackManifestHash = createHash("sha256").update(JSON.stringify(fallbackManifest)).digest("hex");
  if (!items.length && mode === "approved_only" && approvedItems.length > 0) {
    const latest = plan.exportRuns[0];
    if (latest && (latest.manifestHash === fallbackManifestHash || normalizedManifestHash(latest.itemManifest) === fallbackManifestHash) && !options.allowRepeat) {
      throw new ApiError("这批反馈已经按相同文本导出过；如需重复下载，请确认后重试", 409, "repeat_export", false);
    }
    if (options.allowRepeat) items = approvedItems;
  }
  if (!items.length) throw new ApiError("没有新的已批准反馈可导出", 409, "conflict", false);
  const selectedItemIds = new Set(items.map((item) => item.id));
  const missingAttachments = plan.attachments.filter((attachment) => (
    attachment.status === "missing"
    && (!attachment.planItemId || selectedItemIds.has(attachment.planItemId))
  ));
  if (missingAttachments.length) {
    throw new ApiError(`有 ${missingAttachments.length} 个发送附件缺失或校验失败，请移除或重新选择附件`, 409, "conflict", false);
  }
  const manifest = items.map((item) => ({ itemId: item.id, finalTextHash: item.finalTextHash ?? "" }));
  const manifestHash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  const latestRun = plan.exportRuns[0];
  if (latestRun && (latestRun.manifestHash === manifestHash || normalizedManifestHash(latestRun.itemManifest) === manifestHash) && !options.allowRepeat) {
    throw new ApiError("这批反馈已经按相同文本导出过；如需重复下载，请确认后重试", 409, "repeat_export", false);
  }
  const compositions = new Map(items.map((item) => {
    try { return [item.id, JSON.parse(item.compositionSnapshot) as { closureType?: string; needParentAction?: boolean; modules?: Array<{ key: string; content: string; status: string }> }]; }
    catch { return [item.id, {}]; }
  }));
  const feedbackRows = items.map((item) => ({
    类型: plan.type,
    姓名: item.student?.name ?? "班级公共反馈",
    学号: item.student?.studentId ?? "",
    反馈状态: item.status,
    结尾类型: compositions.get(item.id)?.closureType ?? "",
    家长动作: compositions.get(item.id)?.needParentAction ? "需要" : "不需要",
    最终反馈: item.finalText,
  }));
  const teacherRows = items.map((item) => {
    const composition = compositions.get(item.id);
    const evidence = (() => { try { return JSON.parse(item.evidenceSnapshot) as { teachingEvidence?: Array<{ content: string }> }; } catch { return {}; } })();
    return {
      姓名: item.student?.name ?? "班级公共反馈",
      证据: evidence.teachingEvidence?.map((entry) => entry.content).join("；") ?? "",
      采用模块: composition?.modules?.filter((module) => module.status === "included").map((module) => module.key).join("、") ?? "",
      审核: item.auditSnapshot,
      最终反馈: item.finalText,
    };
  });
  const taskRows = plan.tasks.filter((task) => !task.planItemId || selectedItemIds.has(task.planItemId)).map((task) => ({
    学生: task.student?.name ?? "班级",
    任务: task.action,
    截止: task.dueSession ? `${task.dueSession.date} ${task.dueSession.code}` : task.dueDate ?? "",
    预计分钟: task.estimatedMinutes ?? "",
    状态: task.status,
  }));
  const attachmentRows = plan.attachments.filter((attachment) => !attachment.planItemId || selectedItemIds.has(attachment.planItemId)).map((attachment) => ({
    文件名: attachment.displayName,
    类型: attachment.mimeType,
    大小: attachment.sizeBytes,
    SHA256: attachment.sha256,
    定位符: attachment.relativeLocator,
    状态: attachment.status,
  }));
  const workbook = XLSX.utils.book_new();
  const feedbackWorksheet = XLSX.utils.json_to_sheet(feedbackRows);
  feedbackWorksheet["!cols"] = [{ wch: 16 }, { wch: 16 }, { wch: 18 }, { wch: 14 }, { wch: 22 }, { wch: 12 }, { wch: 70 }];
  feedbackWorksheet["!freeze"] = { xSplit: 1, ySplit: 1 };
  const teacherWorksheet = XLSX.utils.json_to_sheet(teacherRows);
  teacherWorksheet["!cols"] = [{ wch: 16 }, { wch: 70 }, { wch: 36 }, { wch: 60 }, { wch: 70 }];
  XLSX.utils.book_append_sheet(workbook, feedbackWorksheet, "课后反馈");
  XLSX.utils.book_append_sheet(workbook, teacherWorksheet, "教师内部研判");
  if (taskRows.length) XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(taskRows), "教师待办");
  if (attachmentRows.length) XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(attachmentRows), "附件清单");
  const buffer = new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }));
  await prisma.$transaction(async (tx) => {
    await tx.feedbackExportRun.create({ data: { planId, mode, itemManifest: JSON.stringify(manifest), manifestHash, isRepeat: options.allowRepeat === true } });
    await tx.feedbackPlanItem.updateMany({ where: { id: { in: items.map((item) => item.id) } }, data: { status: "exported", exportedAt: new Date() } });
    const allExported = plan.items.every((item) => items.some((selected) => selected.id === item.id) || item.status === "exported");
    await tx.feedbackPlan.update({ where: { id: planId }, data: { status: allExported ? "exported" : "partially_exported", exportedAt: new Date() } });
  });
  return buffer;
}

/** Builds one workbook from approved student items across a persisted batch. */
export async function buildFeedbackPlanBatchExportWorkbook(
  prisma: PrismaClient,
  batchId: string,
  mode: "complete" | "approved_only" = "approved_only",
  options: { allowRepeat?: boolean } = {},
) {
  const batch = await prisma.feedbackPlanBatch.findUnique({
    where: { id: batchId },
    include: {
      plans: {
        orderBy: { batchOrder: "asc" },
        include: {
          class: { select: { code: true, name: true } },
          items: { include: { student: { select: { name: true, studentId: true } }, attachments: true } },
          tasks: { include: { student: { select: { name: true } }, dueSession: { select: { code: true, date: true } } } },
          attachments: true,
        },
      },
      exportRuns: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!batch) throw new ApiError("反馈批次不存在", 404, "not_found", false);
  if (batch.archivedAt) throw new ApiError("已归档反馈批次为只读", 409, "conflict", false);

  const initiallyExported = new Set<string>();
  for (const run of batch.exportRuns) {
    try {
      const entries = JSON.parse(run.itemManifest) as Array<{ itemId?: unknown }>;
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (typeof entry.itemId === "string") initiallyExported.add(entry.itemId);
      }
    } catch { /* malformed historical ledgers do not authorize skipping items */ }
  }
  const initialItems = batch.plans.flatMap((plan) => plan.items.map((item) => ({ plan, item })));
  const initialPending = initialItems.filter(({ item }) => !["approved", "exported"].includes(item.status) || !item.finalText?.trim());
  if (mode === "complete" && initialPending.length) throw new ApiError(`还有 ${initialPending.length} 条反馈未批准`, 409, "conflict", false);
  const initiallySelected = initialItems.filter(({ item }) => (
    ["approved", "exported"].includes(item.status)
    && item.finalText?.trim()
    && (mode === "complete" || !initiallyExported.has(item.id))
  ));
  if (!initiallySelected.length) throw new ApiError("没有新的已批准反馈可合并导出", 409, "conflict", false);
  const relevantPlanIds = new Set(initiallySelected.map(({ plan }) => plan.id));
  for (const planId of relevantPlanIds) await validateFeedbackPlanAttachments(planId, prisma);
  const refreshed = await prisma.feedbackPlanBatch.findUnique({
    where: { id: batchId },
    include: {
      plans: {
        orderBy: { batchOrder: "asc" },
        include: {
          class: { select: { code: true, name: true } },
          items: { include: { student: { select: { name: true, studentId: true } }, attachments: true } },
          tasks: { include: { student: { select: { name: true } }, dueSession: { select: { code: true, date: true } } } },
          attachments: true,
        },
      },
      exportRuns: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!refreshed) throw new ApiError("反馈批次不存在", 404, "not_found", false);

  const previouslyBatchExported = new Set<string>();
  for (const run of refreshed.exportRuns) {
    try {
      const manifest = JSON.parse(run.itemManifest) as Array<{ itemId?: unknown }>;
      for (const entry of Array.isArray(manifest) ? manifest : []) {
        if (typeof entry.itemId === "string") previouslyBatchExported.add(entry.itemId);
      }
    } catch { /* malformed historical ledgers do not authorize skipping items */ }
  }
  const allItems = refreshed.plans.flatMap((plan) => plan.items.map((item) => ({ plan, item })));
  const notApproved = allItems.filter(({ item }) => !["approved", "exported"].includes(item.status) || !item.finalText?.trim());
  if (mode === "complete" && notApproved.length) throw new ApiError(`还有 ${notApproved.length} 条反馈未批准`, 409, "conflict", false);
  const approved = allItems.filter(({ item }) => ["approved", "exported"].includes(item.status) && item.finalText?.trim());
  const selected = mode === "approved_only"
    ? approved.filter(({ item }) => !previouslyBatchExported.has(item.id))
    : approved;
  if (!selected.length) throw new ApiError("没有新的已批准反馈可合并导出", 409, "conflict", false);

  const selectedIds = new Set(selected.map(({ item }) => item.id));
  for (const plan of refreshed.plans) {
    const hasSelectedItem = plan.items.some((item) => selectedIds.has(item.id));
    if (!hasSelectedItem) continue;
    const missing = plan.attachments.filter((attachment) => attachment.status === "missing" && (!attachment.planItemId || selectedIds.has(attachment.planItemId)));
    if (missing.length) throw new ApiError(`班级 ${plan.class.code} 有 ${missing.length} 个本次导出所需附件缺失`, 409, "conflict", false);
  }

  const manifest = selected.map(({ plan, item }) => ({
    planId: plan.id,
    itemId: item.id,
    finalTextHash: item.finalTextHash ?? createHash("sha256").update(item.finalText ?? "").digest("hex"),
  }));
  const manifestHash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  if (refreshed.exportRuns.some((run) => run.manifestHash === manifestHash) && !options.allowRepeat) {
    throw new ApiError("相同条目和文本已经合并导出；如需完整重导，请二次确认", 409, "repeat_export", false);
  }

  const feedbackRows = selected.map(({ plan, item }) => ({
    班级编号: plan.class.code,
    班级名称: plan.class.name,
    类型: plan.type,
    姓名: item.student?.name ?? "",
    学号: item.student?.studentId ?? "",
    反馈状态: item.status,
    最终反馈: item.finalText ?? "",
  }));
  const teacherRows = selected.map(({ plan, item }) => {
    const evidence = (() => { try { return JSON.parse(item.evidenceSnapshot) as { teachingEvidence?: Array<{ content: string }> }; } catch { return {}; } })();
    const composition = (() => { try { return JSON.parse(item.compositionSnapshot) as { modules?: Array<{ key: string; status: string }> }; } catch { return {}; } })();
    return {
      班级编号: plan.class.code,
      班级名称: plan.class.name,
      姓名: item.student?.name ?? "",
      证据: evidence.teachingEvidence?.map((entry) => entry.content).join("；") ?? "",
      采用模块: composition.modules?.filter((module) => module.status === "included").map((module) => module.key).join("、") ?? "",
      审核: item.auditSnapshot,
      最终反馈: item.finalText ?? "",
    };
  });
  const taskRows = refreshed.plans.flatMap((plan) => {
    if (!plan.items.some((item) => selectedIds.has(item.id))) return [];
    return plan.tasks.filter((task) => !task.planItemId || selectedIds.has(task.planItemId)).map((task) => ({
      班级编号: plan.class.code,
      班级名称: plan.class.name,
      学生: task.student?.name ?? "班级",
      任务: task.action,
      截止: task.dueSession ? `${task.dueSession.date} ${task.dueSession.code}` : task.dueDate ?? "",
      预计分钟: task.estimatedMinutes ?? "",
      状态: task.status,
    }));
  });
  const attachmentRows = refreshed.plans.flatMap((plan) => {
    if (!plan.items.some((item) => selectedIds.has(item.id))) return [];
    return plan.attachments.filter((attachment) => !attachment.planItemId || selectedIds.has(attachment.planItemId)).map((attachment) => ({
      班级编号: plan.class.code,
      班级名称: plan.class.name,
      文件名: attachment.displayName,
      类型: attachment.mimeType,
      大小: attachment.sizeBytes,
      SHA256: attachment.sha256,
      定位符: attachment.relativeLocator,
      状态: attachment.status,
    }));
  });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(feedbackRows), "课后反馈");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(teacherRows), "教师内部研判");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(taskRows.length ? taskRows : [{ 班级编号: "", 班级名称: "", 学生: "", 任务: "", 截止: "", 预计分钟: "", 状态: "" }]), "教师待办");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(attachmentRows.length ? attachmentRows : [{ 班级编号: "", 班级名称: "", 文件名: "", 类型: "", 大小: "", SHA256: "", 定位符: "", 状态: "" }]), "附件清单");
  const buffer = new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }));
  const workbookSha256 = createHash("sha256").update(buffer).digest("hex");

  await prisma.$transaction(async (tx) => {
    const batchRun = await tx.feedbackPlanBatchExportRun.create({
      data: { batchId, mode, itemManifest: JSON.stringify(manifest), manifestHash, workbookSha256, isRepeat: options.allowRepeat === true },
    });
    for (const plan of refreshed.plans) {
      const planItems = selected.filter((entry) => entry.plan.id === plan.id).map((entry) => entry.item);
      if (!planItems.length) continue;
      const childManifest = planItems.map((item) => ({ itemId: item.id, finalTextHash: item.finalTextHash ?? createHash("sha256").update(item.finalText ?? "").digest("hex") }));
      await tx.feedbackExportRun.create({
        data: {
          planId: plan.id,
          batchExportRunId: batchRun.id,
          mode,
          itemManifest: JSON.stringify(childManifest),
          manifestHash: createHash("sha256").update(JSON.stringify(childManifest)).digest("hex"),
          isRepeat: options.allowRepeat === true,
        },
      });
      await tx.feedbackPlanItem.updateMany({ where: { id: { in: planItems.map((item) => item.id) } }, data: { status: "exported", exportedAt: new Date() } });
      const allExported = plan.items.every((item) => item.status === "exported" || planItems.some((selectedItem) => selectedItem.id === item.id));
      await tx.feedbackPlan.update({ where: { id: plan.id }, data: { status: allExported ? "exported" : "partially_exported", exportedAt: new Date() } });
    }
  });
  return buffer;
}

/** Builds a no-send handoff package for WCG from teacher-approved personal feedback. */
export async function buildWeComDraftPackage(
  prisma: PrismaClient,
  planId: string,
): Promise<WeComDraftPackageV1> {
  const plan = await prisma.feedbackPlan.findUnique({
    where: { id: planId },
    select: {
      id: true,
      planRevision: true,
      type: true,
      items: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          studentId: true,
          status: true,
          finalText: true,
          approvedAt: true,
          student: { select: { name: true, studentId: true } },
        },
      },
    },
  });
  if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);

  const items = plan.items.flatMap((item) => {
    const text = item.finalText?.trim() ?? "";
    if (!item.studentId || !item.student || !item.approvedAt || !text || !["approved", "exported"].includes(item.status)) return [];
    const textSha256 = createHash("sha256").update(text).digest("hex");
    return [{
      itemId: item.id,
      studentRef: {
        id: item.studentId,
        businessId: item.student.studentId,
        displayName: item.student.name,
      },
      text,
      textSha256,
      approvedAt: item.approvedAt.toISOString(),
    }];
  });
  if (!items.length) throw new ApiError("没有可呈递的已批准个人反馈", 409, "conflict", false);

  const manifest = items.map((item) => ({
    itemId: item.itemId,
    studentId: item.studentRef.id,
    textSha256: item.textSha256,
  }));
  const manifestSha256 = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  const packageSeed = {
    contractVersion: WECOM_DRAFT_PACKAGE_CONTRACT_VERSION,
    planId: plan.id,
    planRevision: plan.planRevision,
    manifestSha256,
  };
  const packageHash = createHash("sha256").update(JSON.stringify(packageSeed)).digest("hex");

  return {
    contractVersion: WECOM_DRAFT_PACKAGE_CONTRACT_VERSION,
    packageId: `st-draft-${packageHash}`,
    createdAt: new Date().toISOString(),
    manifestSha256,
    plan: { id: plan.id, revision: plan.planRevision, type: plan.type },
    items,
  };
}
