import type { PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { parseAssessmentPdf } from "@/services/assessment-pdf-service";
import { parseAssistantRosterFiles } from "@/services/assistant-roster-import-service";
import {
  classifyFeedbackIntakeFile,
  createOrGetFeedbackIntakeRun,
  expandFeedbackIntakeFiles,
  getFeedbackIntakeRun,
  resolveIntakeStudentIdentity,
  type FeedbackIntakeRunView,
  type IntakeFile,
  type IntakeKind,
} from "@/services/feedback-intake-service";
import { ServiceError } from "@/services/service-error";
import { parseStepClassroomEnvelope } from "@/services/step-classroom-import-service";

type GroupIntakeKind = IntakeKind | "ignored";

export type FeedbackGroupIntakeSourceStatus =
  | "empty"
  | "complete"
  | "partial"
  | "unassigned"
  | "needs_review";

export type FeedbackGroupIntakeSourceSummary =
  | {
      kind: "assistant_roster" | "step_classroom";
      fileCount: number;
      matchedClasses: number;
      totalClasses: number;
      issueCount: number;
      status: FeedbackGroupIntakeSourceStatus;
    }
  | {
      kind: "assessment_pdf";
      fileCount: number;
      matchedStudents: number;
      totalStudents: number;
      issueCount: number;
      status: FeedbackGroupIntakeSourceStatus;
    };

export interface FeedbackGroupIntakeUnassigned {
  fileName: string;
  kind: GroupIntakeKind;
  reason: string;
  blocking?: boolean;
  reportedStudentId?: string;
  reportedStudentName?: string;
  candidateStudentIds?: string[];
  candidateClassIds?: string[];
}

export interface FeedbackGroupIntakeClass {
  classId: string;
  classCode: string;
  className: string;
  sessionCode: string;
  studentIds: string[];
  studentCount: number;
  runId: string;
  status: string;
  issueCount: number;
}

export interface FeedbackGroupIntakeResult {
  runs: FeedbackIntakeRunView[];
  classes: FeedbackGroupIntakeClass[];
  sourceSummaries: FeedbackGroupIntakeSourceSummary[];
  unassigned: FeedbackGroupIntakeUnassigned[];
}

export interface CreateFeedbackGroupIntakeInput {
  groupLessonId: string;
  files: IntakeFile[];
  sessionCodes?: string[];
  runIds?: Record<string, string>;
  db?: PrismaClient;
}

type GroupSessionContext = {
  classId: string;
  classCode: string;
  className: string;
  sessionId: string;
  sessionCode: string;
  sessionDate: string;
  students: Array<{ id: string; name: string; studentId: string }>;
};

function sourceStatus(input: {
  fileCount: number;
  matched: number;
  total: number;
  issueCount: number;
}): FeedbackGroupIntakeSourceStatus {
  if (input.fileCount === 0) return "empty";
  if (input.issueCount > 0) return "needs_review";
  if (input.matched === 0) return "unassigned";
  if (input.matched < input.total) return "partial";
  return "complete";
}

function unique(values: string[]) {
  return [...new Set(values)];
}

export function parseFeedbackGroupRunIds(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceError("runIds 必须是课次到材料运行的 JSON 对象", 400);
  }
  const entries = Object.entries(value);
  if (entries.some(([sessionCode, runId]) => !sessionCode.trim() || typeof runId !== "string" || !runId.trim())) {
    throw new ServiceError("runIds 中的课次和材料运行不能为空", 400);
  }
  return Object.fromEntries(entries.map(([sessionCode, runId]) => [sessionCode.trim(), String(runId).trim()]));
}

export function parseFeedbackGroupSessionCodes(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (!Array.isArray(value) || value.some((sessionCode) => typeof sessionCode !== "string" || !sessionCode.trim())) {
    throw new ServiceError("sessionCodes 必须是非空课次数组", 400);
  }
  const sessionCodes = unique(value.map((sessionCode) => sessionCode.trim()));
  if (!sessionCodes.length) throw new ServiceError("sessionCodes 必须是非空课次数组", 400);
  return sessionCodes;
}

async function loadGroupSessionContexts(groupLessonId: string, db: PrismaClient) {
  const lesson = await db.groupLesson.findUnique({
    where: { id: groupLessonId },
    select: {
      id: true,
      sessionLinks: {
        select: {
          session: {
            select: {
              id: true,
              code: true,
              date: true,
              semesterId: true,
              classId: true,
              class: { select: { id: true, code: true, name: true } },
            },
          },
        },
      },
    },
  });
  if (!lesson) throw new ServiceError("共同课不存在", 404);
  if (!lesson.sessionLinks.length) throw new ServiceError("共同课还没有已关联的真实课次", 409);

  const sessions = lesson.sessionLinks.map(({ session }) => {
    if (!session.classId || !session.class) throw new ServiceError("共同课包含未关联班级的课次", 409);
    return session as typeof session & { classId: string; class: NonNullable<typeof session.class> };
  });
  const contexts = await Promise.all(sessions.map(async (session): Promise<GroupSessionContext> => {
    const students = await db.student.findMany({
      where: {
        enrollments: { some: { semesterId: session.semesterId, classId: session.classId, rosterStatus: "ACTIVE" } },
      },
      select: { id: true, name: true, studentId: true },
      orderBy: { studentId: "asc" },
    });
    return {
      classId: session.classId,
      classCode: session.class.code,
      className: session.class.name ?? session.class.code,
      sessionId: session.id,
      sessionCode: session.code,
      sessionDate: session.date,
      students,
    };
  }));

  return contexts.sort((left, right) => (
    left.classCode.localeCompare(right.classCode, "zh-CN", { numeric: true })
    || left.sessionCode.localeCompare(right.sessionCode)
  ));
}

export async function createFeedbackGroupIntake(
  input: CreateFeedbackGroupIntakeInput,
): Promise<FeedbackGroupIntakeResult> {
  const db = input.db ?? prisma;
  const groupLessonId = input.groupLessonId.trim();
  if (!groupLessonId) throw new ServiceError("缺少共同课", 400);
  const allContexts = await loadGroupSessionContexts(groupLessonId, db);
  const selectedSessionCodes = parseFeedbackGroupSessionCodes(input.sessionCodes);
  const allSessionCodes = new Set(allContexts.map((context) => context.sessionCode));
  const unknownSessionCode = selectedSessionCodes?.find((sessionCode) => !allSessionCodes.has(sessionCode));
  if (unknownSessionCode) throw new ServiceError("所选课次不属于当前共同课", 409);
  const selectedSessionCodeSet = selectedSessionCodes ? new Set(selectedSessionCodes) : allSessionCodes;
  const contexts = allContexts.filter((context) => selectedSessionCodeSet.has(context.sessionCode));
  const emptyRosterContext = contexts.find((context) => context.students.length === 0);
  if (emptyRosterContext) {
    throw new ServiceError(`${emptyRosterContext.className} 没有在读学生，暂时不能统一投料`, 409);
  }
  const runIds = parseFeedbackGroupRunIds(input.runIds);
  const linkedSessionCodes = new Set(contexts.map((context) => context.sessionCode));
  const unknownRunSession = Object.keys(runIds ?? {}).find((sessionCode) => !linkedSessionCodes.has(sessionCode));
  if (unknownRunSession) throw new ServiceError("材料运行包含不属于当前共同课的课次", 409);
  const reusedRunIds = Object.values(runIds ?? {}).filter(Boolean);
  if (new Set(reusedRunIds).size !== reusedRunIds.length) throw new ServiceError("不同课次不能复用同一材料运行", 409);
  if (reusedRunIds.length) {
    const suppliedRuns = await db.feedbackIntakeRun.findMany({
      where: { id: { in: reusedRunIds } },
      select: { id: true, sessionCode: true, planId: true },
    });
    const suppliedPlanIds = [...new Set(suppliedRuns.flatMap((run) => run.planId ? [run.planId] : []))];
    const livePlanIds = new Set((await db.feedbackPlan.findMany({
      where: { id: { in: suppliedPlanIds }, archivedAt: null },
      select: { id: true },
    })).map((plan) => plan.id));
    const suppliedRunById = new Map(suppliedRuns.map((run) => [run.id, run]));
    for (const [sessionCode, runId] of Object.entries(runIds ?? {})) {
      const run = suppliedRunById.get(runId);
      if (!run) throw new ServiceError("反馈材料运行不存在", 404);
      if (run.sessionCode !== sessionCode) throw new ServiceError("不能把材料运行复用到另一课次", 409);
      if (run.planId && livePlanIds.has(run.planId)) throw new ServiceError("这轮材料已经关联反馈计划，请重新开始一轮材料", 409);
    }
  }

  let expanded: ReturnType<typeof expandFeedbackIntakeFiles>;
  try {
    expanded = expandFeedbackIntakeFiles(input.files);
  } catch (error) {
    throw new ServiceError(error instanceof Error ? error.message : "组投料文件无法展开", 400);
  }
  const filesBySession = new Map(contexts.map((context) => [context.sessionCode, [] as IntakeFile[]]));
  const matchedClasses = {
    assistant_roster: new Set<string>(),
    step_classroom: new Set<string>(),
  };
  const matchedAssessmentStudents = new Set<string>();
  const unassigned: FeedbackGroupIntakeUnassigned[] = [];
  const sourceKindByName = new Map<string, IntakeKind>();
  const uniqueRoster = [...new Map(
    allContexts.flatMap((context) => context.students.map((student) => [student.id, student] as const)),
  ).values()];

  function routeFile(context: GroupSessionContext, file: IntakeFile, kind: IntakeKind) {
    filesBySession.get(context.sessionCode)!.push(file);
    if (kind === "assistant_roster" || kind === "step_classroom") matchedClasses[kind].add(context.classId);
  }

  for (const file of expanded) {
    const kind = classifyFeedbackIntakeFile(file.name, file.buffer);
    const routedFile: IntakeFile = {
      name: file.displayName,
      buffer: file.buffer,
      source: file.source,
    };
    if (kind === "ignored") {
      unassigned.push({ fileName: file.displayName, kind, reason: "文件类型不属于统一课后材料", blocking: false });
      continue;
    }
    sourceKindByName.set(file.displayName, kind);

    if (kind === "assistant_roster") {
      try {
        const rows = parseAssistantRosterFiles([{ name: file.displayName, buffer: file.buffer }]);
        const targets = new Map<string, GroupSessionContext>();
        let classIdentityConflict = false;
        for (const row of rows) {
          const codeTargets = allContexts.filter((context) => context.classCode === row.classCode);
          const nameTargets = row.className
            ? allContexts.filter((context) => context.className === row.className)
            : [];
          if (codeTargets.length && nameTargets.length && !codeTargets.some((codeTarget) => nameTargets.some((nameTarget) => nameTarget.classId === codeTarget.classId))) {
            classIdentityConflict = true;
            break;
          }
          for (const target of codeTargets.length ? codeTargets : nameTargets) targets.set(target.classId, target);
        }
        if (classIdentityConflict) {
          unassigned.push({ fileName: file.displayName, kind, reason: "助教表中的班级编号与班级名称互相冲突" });
          continue;
        }
        if (!targets.size) {
          unassigned.push({ fileName: file.displayName, kind, reason: "助教表中没有当前共同课班级的有效课堂记录", blocking: file.source !== "inbox" });
          continue;
        }
        const selectedTargets = [...targets.values()].filter((target) => selectedSessionCodeSet.has(target.sessionCode));
        const skippedTargets = [...targets.values()].filter((target) => !selectedSessionCodeSet.has(target.sessionCode));
        if (skippedTargets.length) {
          unassigned.push({
            fileName: file.displayName,
            kind,
            reason: "助教表中属于本轮未选班级的记录已跳过",
            blocking: false,
            candidateClassIds: skippedTargets.map((target) => target.classId),
          });
        }
        for (const target of selectedTargets) routeFile(target, routedFile, kind);
      } catch (error) {
        unassigned.push({
          fileName: file.displayName,
          kind,
          reason: error instanceof Error ? error.message : "助教表无法解析",
          blocking: file.source !== "inbox",
        });
      }
      continue;
    }

    if (kind === "step_classroom") {
      try {
        const envelope = parseStepClassroomEnvelope(Buffer.from(file.buffer).toString("utf8"));
        const target = allContexts.find((context) => context.classCode === envelope.payload.class.code);
        if (!target) {
          unassigned.push({ fileName: file.displayName, kind, reason: `STEP 班级 ${envelope.payload.class.code} 不属于当前共同课`, blocking: file.source !== "inbox" });
          continue;
        }
        if (!selectedSessionCodeSet.has(target.sessionCode)) {
          unassigned.push({
            fileName: file.displayName,
            kind,
            reason: `STEP 班级 ${envelope.payload.class.code} 未纳入本轮处理，已跳过`,
            blocking: false,
            candidateClassIds: [target.classId],
          });
          continue;
        }
        routeFile(target, routedFile, kind);
      } catch (error) {
        unassigned.push({
          fileName: file.displayName,
          kind,
          reason: error instanceof Error ? error.message : "STEP 文件无法解析",
          blocking: file.source !== "inbox",
        });
      }
      continue;
    }

    try {
      const parsed = await parseAssessmentPdf(file.buffer, file.displayName);
      const identity = resolveIntakeStudentIdentity(uniqueRoster, parsed.reportStudentId, parsed.reportStudentName);
      const candidateStudentIds = unique(identity.candidates.map((candidate) => candidate.id));
      const candidateContexts = allContexts
        .filter((context) => context.students.some((student) => candidateStudentIds.includes(student.id)))
      const candidateClassIds = unique(candidateContexts.map((context) => context.classId));
      const candidatesOnlyInUnselectedClasses = candidateContexts.length > 0
        && candidateContexts.every((context) => !selectedSessionCodeSet.has(context.sessionCode));
      if (identity.conflict || !identity.match) {
        unassigned.push({
          fileName: file.displayName,
          kind,
          reason: candidatesOnlyInUnselectedClasses
            ? "PDF 候选学生均属于本轮未选班级，已跳过"
            : identity.conflict
            ? "PDF 内学号和姓名不能唯一指向同一名组内学生"
            : candidateStudentIds.length > 1
              ? "PDF 姓名在班级组内重名，无法自动归属"
              : "PDF 未能匹配班级组花名册",
          blocking: candidatesOnlyInUnselectedClasses
            ? false
            : identity.conflict || candidateStudentIds.length > 0 || file.source !== "inbox",
          reportedStudentId: parsed.reportStudentId,
          reportedStudentName: parsed.reportStudentName,
          ...(candidateStudentIds.length ? { candidateStudentIds } : {}),
          ...(candidateClassIds.length ? { candidateClassIds } : {}),
        });
        continue;
      }
      const studentContexts = allContexts.filter((context) => context.students.some((student) => student.id === identity.match!.id));
      const reportDateContexts = studentContexts.filter((context) => context.sessionDate === parsed.evidence.reportDate);
      const target = studentContexts.length === 1
        ? studentContexts[0]
        : reportDateContexts.length === 1
          ? reportDateContexts[0]
          : undefined;
      if (target && !selectedSessionCodeSet.has(target.sessionCode)) {
        unassigned.push({
          fileName: file.displayName,
          kind,
          reason: "PDF 学生属于本轮未选班级，已跳过",
          blocking: false,
          reportedStudentId: parsed.reportStudentId,
          reportedStudentName: parsed.reportStudentName,
          candidateStudentIds: [identity.match.id],
          candidateClassIds: [target.classId],
        });
        continue;
      }
      if (!target) {
        const onlyInUnselectedClasses = studentContexts.length > 0
          && studentContexts.every((context) => !selectedSessionCodeSet.has(context.sessionCode));
        unassigned.push({
          fileName: file.displayName,
          kind,
          reason: onlyInUnselectedClasses
            ? "PDF 学生仅属于本轮未选班级，已跳过"
            : "该学生对应多个真实课次，无法自动确定 PDF 所属班级",
          blocking: onlyInUnselectedClasses ? false : undefined,
          reportedStudentId: parsed.reportStudentId,
          reportedStudentName: parsed.reportStudentName,
          candidateStudentIds: [identity.match.id],
          candidateClassIds: unique(studentContexts.map((context) => context.classId)),
        });
        continue;
      }
      routeFile(target, routedFile, kind);
      matchedAssessmentStudents.add(identity.match.id);
    } catch (error) {
      unassigned.push({
        fileName: file.displayName,
        kind,
        reason: error instanceof Error ? error.message : "PDF 无法解析",
        blocking: file.source !== "inbox",
      });
    }
  }

  // Group routing parses each PDF once. The existing per-session intake service
  // remains the source-of-truth for its issue ledger, so an assigned PDF is
  // parsed once more there until that service accepts pre-parsed evidence.
  const runResults = await Promise.all(contexts.map(async (context) => {
    const files = filesBySession.get(context.sessionCode) ?? [];
    const runId = runIds?.[context.sessionCode];
    if (runId && files.length === 0) {
      const existing = await getFeedbackIntakeRun(runId, db);
      if (!existing) throw new ServiceError("反馈材料运行不存在", 404);
      if (existing.sessionCode !== context.sessionCode) throw new ServiceError("不能把材料运行复用到另一课次", 409);
      if (existing.planId) throw new ServiceError("这轮材料已经关联反馈计划，请重新开始一轮材料", 409);
      return { run: existing };
    }
    return createOrGetFeedbackIntakeRun({
      sessionCode: context.sessionCode,
      files,
      ...(runId ? { runId } : {}),
      db,
    });
  }));
  const runs = runResults.map((result) => result.run);
  const sourceNamesByKind: Record<IntakeKind, Set<string>> = {
    assistant_roster: new Set<string>(),
    step_classroom: new Set<string>(),
    assessment_pdf: new Set<string>(),
  };
  for (const item of unassigned) {
    if (item.kind !== "ignored" && item.blocking !== false) sourceNamesByKind[item.kind].add(item.fileName);
  }
  runs.forEach((run, index) => {
    for (const source of run.sourceManifest) {
      if (source.kind !== "assistant_roster" && source.kind !== "step_classroom" && source.kind !== "assessment_pdf") continue;
      if (typeof source.name === "string" && source.name) {
        sourceNamesByKind[source.kind].add(source.name);
        sourceKindByName.set(source.name, source.kind);
      }
      if (source.kind === "assistant_roster" || source.kind === "step_classroom") {
        matchedClasses[source.kind].add(contexts[index]!.classId);
      }
    }
    for (const studentId of Object.keys(run.appliedSummary.assessmentEvidence ?? {})) {
      matchedAssessmentStudents.add(studentId);
    }
  });
  const routingIssueCount: Record<IntakeKind, number> = {
    assistant_roster: unassigned.filter((item) => item.kind === "assistant_roster" && item.blocking !== false).length,
    step_classroom: unassigned.filter((item) => item.kind === "step_classroom" && item.blocking !== false).length,
    assessment_pdf: unassigned.filter((item) => item.kind === "assessment_pdf" && item.blocking !== false).length,
  };
  for (const run of runs) {
    if (run.status !== "applied") {
      for (const issue of run.issues) {
        const kind = issue.sourceName ? sourceKindByName.get(issue.sourceName) : undefined;
        if (kind) routingIssueCount[kind] += 1;
      }
    }
  }

  const totalStudents = new Set(contexts.flatMap((context) => context.students.map((student) => student.id))).size;
  const sourceSummaries: FeedbackGroupIntakeSourceSummary[] = [
    {
      kind: "assistant_roster",
      fileCount: sourceNamesByKind.assistant_roster.size,
      matchedClasses: matchedClasses.assistant_roster.size,
      totalClasses: contexts.length,
      issueCount: routingIssueCount.assistant_roster,
      status: sourceStatus({
        fileCount: sourceNamesByKind.assistant_roster.size,
        matched: matchedClasses.assistant_roster.size,
        total: contexts.length,
        issueCount: routingIssueCount.assistant_roster,
      }),
    },
    {
      kind: "step_classroom",
      fileCount: sourceNamesByKind.step_classroom.size,
      matchedClasses: matchedClasses.step_classroom.size,
      totalClasses: contexts.length,
      issueCount: routingIssueCount.step_classroom,
      status: sourceStatus({
        fileCount: sourceNamesByKind.step_classroom.size,
        matched: matchedClasses.step_classroom.size,
        total: contexts.length,
        issueCount: routingIssueCount.step_classroom,
      }),
    },
    {
      kind: "assessment_pdf",
      fileCount: sourceNamesByKind.assessment_pdf.size,
      matchedStudents: matchedAssessmentStudents.size,
      totalStudents,
      issueCount: routingIssueCount.assessment_pdf,
      status: sourceStatus({
        fileCount: sourceNamesByKind.assessment_pdf.size,
        matched: matchedAssessmentStudents.size,
        total: totalStudents,
        issueCount: routingIssueCount.assessment_pdf,
      }),
    },
  ];

  return {
    runs,
    classes: contexts.map((context, index) => ({
      classId: context.classId,
      classCode: context.classCode,
      className: context.className,
      sessionCode: context.sessionCode,
      studentIds: context.students.map((student) => student.id),
      studentCount: context.students.length,
      runId: runs[index]!.id,
      status: runs[index]!.status,
      issueCount: runs[index]!.status === "applied" ? 0 : runs[index]!.issues.length,
    })),
    sourceSummaries,
    unassigned,
  };
}

/**
 * Starts or resumes one independent material run per linked class without
 * adding another file source. This does not copy or rewrite classroom facts;
 * each class plan continues to read its own confirmed classroom records.
 */
export async function prepareFeedbackGroupIntakeFromExistingFacts(input: {
  groupLessonId: string;
  sessionCodes?: string[];
  runIds?: Record<string, string>;
  db?: PrismaClient;
}) {
  return createFeedbackGroupIntake({ ...input, files: [] });
}
