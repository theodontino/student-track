import { createHash } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  TeachingInterpretationSchema,
  type ResolvedTeachingInterpretation,
  type TeachingEvidenceItem,
  type TeachingInterpretation,
  type TeachingStudentFact,
  type TeachingSummaryBundle,
  type TeachingSummaryFacts,
  type TeachingSummaryRequest,
  type TeachingSummaryScope,
} from "@/lib/contracts/teaching-summary";
import {
  FEEDBACK_COMMUNICATION_CATEGORIES,
  isUsefulLegacyFeedbackCommunication,
  parseFeedbackCommunicationSummary,
} from "@/lib/feedback-communication";
import { createLLMClient, getLLMModel } from "@/lib/llm";
import { prisma } from "@/lib/prisma";
import { withLLMCacheOperation } from "@/services/llm-cache-service";
import {
  listTeacherObservations,
  persistObservationCandidates,
  type ResolvedObservationCandidate,
} from "@/services/teacher-observation-service";

const PROMPT_VERSION = "teaching-summary-v1";
const OBSERVATION_VERSION = "teacher-observation-v1";
const MAX_COMMUNICATIONS_PER_STUDENT = 5;
const MAX_COMMUNICATION_INPUT = 120;

const interpretationJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["overview", "classComparisons", "noteworthyChanges", "suggestedActions", "observationCandidates"],
  properties: {
    overview: { type: ["string", "null"], maxLength: 800 },
    classComparisons: { type: "array", maxItems: 8, items: { $ref: "#/$defs/evidence" } },
    noteworthyChanges: { type: "array", maxItems: 12, items: { $ref: "#/$defs/evidence" } },
    suggestedActions: { type: "array", maxItems: 12, items: { $ref: "#/$defs/evidence" } },
    observationCandidates: {
      type: "array",
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["studentRef", "kind", "topic", "title", "evidenceSummary", "communicationRefs", "sessionRefs"],
        properties: {
          studentRef: { type: "string" },
          kind: {
            type: "string",
            enum: [
              "repeated-parent-concern",
              "classroom-alignment",
              "classroom-conflict",
              "pending-teacher-commitment",
              "concern-escalation",
            ],
          },
          topic: { type: "string", enum: FEEDBACK_COMMUNICATION_CATEGORIES },
          title: { type: "string", maxLength: 80 },
          evidenceSummary: { type: "string", maxLength: 360 },
          communicationRefs: { type: "array", minItems: 1, maxItems: 20, items: { type: "string" } },
          sessionRefs: { type: "array", maxItems: 20, items: { type: "string" } },
        },
      },
    },
  },
  $defs: {
    evidence: {
      type: "object",
      additionalProperties: false,
      required: ["title", "detail", "studentRefs", "sessionRefs", "communicationRefs"],
      properties: {
        title: { type: "string", maxLength: 80 },
        detail: { type: "string", maxLength: 360 },
        studentRefs: { type: "array", maxItems: 20, items: { type: "string" } },
        sessionRefs: { type: "array", maxItems: 20, items: { type: "string" } },
        communicationRefs: { type: "array", maxItems: 20, items: { type: "string" } },
      },
    },
  },
} as const;

interface CommunicationInput {
  id: string;
  studentId: string;
  target: string;
  summary: string;
  occurredAt: string;
  category: string;
  priority: string;
  sessionId: string;
  sessionCode: string;
}

interface ReferenceRegistry {
  students: Map<string, { id: string; name: string; href: string }>;
  sessions: Map<string, { id: string; code: string; date: string; href: string }>;
  communications: Map<string, CommunicationInput & { href: string }>;
}

interface TeachingSummaryContext {
  facts: TeachingSummaryFacts;
  sourceFingerprint: string;
  references: ReferenceRegistry;
  promptPayload: unknown;
  involvedStudentIds: Set<string>;
}

function round(value: number, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function composite(metric: { scoreA: number; scoreB: number; scoreC: number }) {
  return round((metric.scoreA + metric.scoreB + metric.scoreC) / 3, 2);
}

function effectiveCommunicationDate(input: {
  summary: string;
  createdAt: Date;
  session: { date: string };
}) {
  const parsed = parseFeedbackCommunicationSummary(input.summary);
  const occurredAt = parsed.occurredAt.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(occurredAt)) return occurredAt;
  return input.session.date || input.createdAt.toISOString().slice(0, 10);
}

function scopeKey(scope: TeachingSummaryScope) {
  return scope.type === "session" ? `session:${scope.sessionCode}` : `date:${scope.semesterId}:${scope.date}`;
}

function sessionHref(session: { code: string; semesterId: string }) {
  return `/quick-score?semesterId=${encodeURIComponent(session.semesterId)}&sessionCode=${encodeURIComponent(session.code)}`;
}

function stableHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function resolveScope(db: PrismaClient, scope: TeachingSummaryScope) {
  if (scope.type === "session") {
    const session = await db.classSession.findUnique({
      where: { code: scope.sessionCode },
      include: {
        semester: { select: { id: true, name: true, startDate: true, endDate: true } },
        class: { select: { id: true, code: true, name: true } },
      },
    });
    if (!session) throw new Error("session_not_found");
    return { semester: session.semester, date: session.date, sessions: [session] };
  }
  const semester = await db.semester.findUnique({ where: { id: scope.semesterId } });
  if (!semester) throw new Error("semester_not_found");
  if (scope.date < semester.startDate || scope.date > semester.endDate) throw new Error("date_outside_semester");
  const sessions = await db.classSession.findMany({
    where: { semesterId: semester.id, date: scope.date },
    orderBy: [{ semesterNumber: "asc" }, { code: "asc" }],
    include: { class: { select: { id: true, code: true, name: true } } },
  });
  return { semester, date: scope.date, sessions };
}

export async function buildTeachingSummaryContext(
  request: TeachingSummaryRequest,
  db: PrismaClient = prisma,
): Promise<TeachingSummaryContext> {
  const resolved = await resolveScope(db, request.scope);
  const sessions = resolved.sessions;
  const sessionIds = sessions.map((session) => session.id);
  const sessionCodes = sessions.map((session) => session.code);
  const classIds = sessions.flatMap((session) => session.classId ? [session.classId] : []);
  const hasSchoolSession = sessions.some((session) => !session.classId);

  const [metrics, attendances, events, selectedCommunications, pendingDrafts, feedbackHistory, roster] = await Promise.all([
    db.sessionMetric.findMany({ where: { sessionId: { in: sessionIds } } }),
    db.attendance.findMany({ where: { sessionId: { in: sessionIds } } }),
    db.event.findMany({ where: { sessionId: { in: sessionIds } } }),
    db.communication.findMany({
      where: { sessionId: { in: sessionIds } },
      include: { session: { select: { id: true, code: true, date: true, semesterId: true } } },
    }),
    db.draftRecord.findMany({
      where: { sessionCode: { in: sessionCodes }, status: "pending" },
      select: { id: true, sessionCode: true, studentId: true },
    }),
    db.workHistory.findMany({
      where: { module: "feedback", key: { in: sessionCodes } },
      select: { key: true },
    }),
    db.student.findMany({
      where: hasSchoolSession ? {} : { classId: { in: classIds } },
      select: { id: true, name: true, classId: true, class: { select: { code: true, name: true } } },
    }),
  ]);

  const participantIds = new Set<string>(roster.map((student) => student.id));
  for (const row of [...metrics, ...attendances, ...events, ...selectedCommunications]) participantIds.add(row.studentId);
  const missingIds = [...participantIds].filter((id) => !roster.some((student) => student.id === id));
  const missingStudents = missingIds.length
    ? await db.student.findMany({
        where: { id: { in: missingIds } },
        select: { id: true, name: true, classId: true, class: { select: { code: true, name: true } } },
      })
    : [];
  const students = [...roster, ...missingStudents].sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));

  const sessionStudentIds = new Map<string, Set<string>>();
  for (const session of sessions) {
    const ids = new Set(roster.filter((student) => !session.classId || student.classId === session.classId).map((student) => student.id));
    sessionStudentIds.set(session.id, ids);
  }
  for (const row of [...metrics, ...attendances, ...events, ...selectedCommunications]) {
    if (row.sessionId) sessionStudentIds.get(row.sessionId)?.add(row.studentId);
  }

  const historicalMetrics = participantIds.size
    ? await db.sessionMetric.findMany({
        where: {
          studentId: { in: [...participantIds] },
          session: { semesterId: resolved.semester.id, date: { lte: resolved.date } },
        },
        include: { session: { select: { id: true, code: true, date: true, semesterNumber: true } } },
      })
    : [];

  const recentCommunicationRows = request.includeCommunications && participantIds.size
    ? await db.communication.findMany({
        where: {
          studentId: { in: [...participantIds] },
          session: { semesterId: resolved.semester.id, date: { lte: resolved.date } },
        },
        orderBy: { createdAt: "desc" },
        take: 500,
        include: { session: { select: { id: true, code: true, date: true, semesterId: true } } },
      })
    : [];
  const selectedCommunicationIds = new Set(selectedCommunications.map((communication) => communication.id));
  const eligibleCommunications = recentCommunicationRows
    .filter((communication) => isUsefulLegacyFeedbackCommunication(communication.summary))
    .map((communication) => {
      const parsed = parseFeedbackCommunicationSummary(communication.summary);
      return {
        id: communication.id,
        studentId: communication.studentId,
        target: communication.target,
        summary: parsed.summary,
        occurredAt: effectiveCommunicationDate(communication),
        category: parsed.decision?.category ?? "legacy",
        priority: parsed.decision?.priority ?? "medium",
        sessionId: communication.session.id,
        sessionCode: communication.session.code,
        selected: selectedCommunicationIds.has(communication.id),
      };
    })
    .sort((left, right) => (
      Number(right.selected) - Number(left.selected)
      || right.occurredAt.localeCompare(left.occurredAt)
      || right.id.localeCompare(left.id)
    ));
  const communicationCounts = new Map<string, number>();
  const communicationInputs: CommunicationInput[] = [];
  for (const communication of eligibleCommunications) {
    const count = communicationCounts.get(communication.studentId) ?? 0;
    if (count >= MAX_COMMUNICATIONS_PER_STUDENT || communicationInputs.length >= MAX_COMMUNICATION_INPUT) continue;
    communicationCounts.set(communication.studentId, count + 1);
    communicationInputs.push(communication);
  }
  const communicationInputTruncated = recentCommunicationRows.length === 500
    || eligibleCommunications.length > communicationInputs.length;

  const metricsBySession = new Map<string, typeof metrics>();
  const attendancesBySession = new Map<string, typeof attendances>();
  const eventsBySession = new Map<string, typeof events>();
  const communicationsBySession = new Map<string, typeof selectedCommunications>();
  for (const metric of metrics) if (metric.sessionId) metricsBySession.set(metric.sessionId, [...(metricsBySession.get(metric.sessionId) ?? []), metric]);
  for (const attendance of attendances) attendancesBySession.set(attendance.sessionId, [...(attendancesBySession.get(attendance.sessionId) ?? []), attendance]);
  for (const event of events) eventsBySession.set(event.sessionId, [...(eventsBySession.get(event.sessionId) ?? []), event]);
  for (const communication of selectedCommunications) communicationsBySession.set(communication.sessionId, [...(communicationsBySession.get(communication.sessionId) ?? []), communication]);
  const feedbackKeys = new Set(feedbackHistory.flatMap((history) => history.key ? [history.key] : []));

  const sessionFacts = sessions.map((session) => {
    const sessionMetrics = metricsBySession.get(session.id) ?? [];
    const sessionAttendances = attendancesBySession.get(session.id) ?? [];
    const sessionEvents = eventsBySession.get(session.id) ?? [];
    const sessionCommunications = communicationsBySession.get(session.id) ?? [];
    const studentCount = sessionStudentIds.get(session.id)?.size ?? 0;
    const average = (key: "scoreA" | "scoreB" | "scoreC" | "scoreD") => (
      sessionMetrics.length
        ? round(sessionMetrics.reduce((sum, metric) => sum + metric[key], 0) / sessionMetrics.length)
        : null
    );
    return {
      id: session.id,
      code: session.code,
      date: session.date,
      semesterNumber: session.semesterNumber,
      classId: session.classId,
      className: session.class?.name ?? session.class?.code ?? "全校",
      studentCount,
      metricRecordedCount: sessionMetrics.length,
      attendanceRecordedCount: sessionAttendances.length,
      presentCount: sessionAttendances.filter((attendance) => attendance.present).length,
      absentCount: sessionAttendances.filter((attendance) => !attendance.present).length,
      eventCount: sessionEvents.length,
      communicationCount: sessionCommunications.length,
      averages: { A: average("scoreA"), B: average("scoreB"), C: average("scoreC"), D: average("scoreD") },
      pendingDraftCount: pendingDrafts.filter((draft) => draft.sessionCode === session.code).length,
      feedbackHistoryFound: feedbackKeys.has(session.code),
      href: sessionHref(session),
    };
  });

  const selectedMetricByStudent = new Map<string, typeof metrics[number]>();
  for (const metric of metrics) {
    if (!metric.sessionId) continue;
    const current = selectedMetricByStudent.get(metric.studentId);
    const currentSession = current?.sessionId ? sessions.find((session) => session.id === current.sessionId) : null;
    const nextSession = sessions.find((session) => session.id === metric.sessionId);
    if (!current || (nextSession?.semesterNumber ?? 0) >= (currentSession?.semesterNumber ?? 0)) {
      selectedMetricByStudent.set(metric.studentId, metric);
    }
  }
  const historyByStudent = new Map<string, typeof historicalMetrics>();
  for (const metric of historicalMetrics) historyByStudent.set(metric.studentId, [...(historyByStudent.get(metric.studentId) ?? []), metric]);
  const selectedSessionIds = new Set(sessionIds);
  const studentFacts: TeachingStudentFact[] = students.flatMap((student) => {
    const participated = sessions.filter((session) => sessionStudentIds.get(session.id)?.has(student.id));
    if (!participated.length) return [];
    const selectedMetric = selectedMetricByStudent.get(student.id);
    const history = [...(historyByStudent.get(student.id) ?? [])]
      .filter((metric): metric is typeof metric & { session: NonNullable<typeof metric.session> } => Boolean(metric.session))
      .sort((left, right) => (
      left.session.date.localeCompare(right.session.date)
      || left.session.semesterNumber - right.session.semesterNumber
      ));
    const previous = [...history].reverse().find((metric) => !selectedSessionIds.has(metric.session.id));
    const selectedComposite = selectedMetric ? composite(selectedMetric) : null;
    const previousComposite = previous ? composite(previous) : null;
    return [{
      id: student.id,
      name: student.name,
      className: student.class.name ?? student.class.code,
      sessionCodes: participated.map((session) => session.code),
      selectedComposite,
      previousComposite,
      change: selectedComposite !== null && previousComposite !== null ? round(selectedComposite - previousComposite) : null,
      eventCount: events.filter((event) => event.studentId === student.id).length,
      communicationCount: communicationInputs.filter((communication) => communication.studentId === student.id).length,
      href: `/students/${encodeURIComponent(student.id)}?semesterId=${encodeURIComponent(resolved.semester.id)}`,
    }];
  });

  const pendingItems: TeachingSummaryFacts["pendingItems"] = [];
  for (const session of sessionFacts) {
    const missingMetrics = Math.max(0, session.studentCount - session.metricRecordedCount);
    const missingAttendance = Math.max(0, session.studentCount - session.attendanceRecordedCount);
    if (missingMetrics) pendingItems.push({ type: "missing-metrics", label: "评分未完整记录", count: missingMetrics, sessionCode: session.code, href: session.href });
    if (missingAttendance) pendingItems.push({ type: "missing-attendance", label: "考勤未完整记录", count: missingAttendance, sessionCode: session.code, href: session.href });
    if (session.pendingDraftCount) pendingItems.push({ type: "pending-drafts", label: "存在待复核草案", count: session.pendingDraftCount, sessionCode: session.code, href: `/history?view=drafts` });
    if (!session.feedbackHistoryFound) pendingItems.push({ type: "feedback-history-missing", label: "未发现反馈工作记录", count: 1, sessionCode: session.code, href: `/feedback?semesterId=${encodeURIComponent(resolved.semester.id)}&sessionCode=${encodeURIComponent(session.code)}` });
  }

  const facts: TeachingSummaryFacts = {
    scope: request.scope,
    scopeKey: scopeKey(request.scope),
    semester: resolved.semester,
    date: resolved.date,
    totals: {
      sessionCount: sessionFacts.length,
      classCount: new Set(sessionFacts.map((session) => session.classId ?? "__school__")).size,
      coveredStudentCount: studentFacts.length,
      metricRecordedCount: metrics.length,
      attendanceRecordedCount: attendances.length,
      presentCount: attendances.filter((attendance) => attendance.present).length,
      absentCount: attendances.filter((attendance) => !attendance.present).length,
      eventCount: events.length,
      pendingDraftCount: pendingDrafts.length,
      missingFeedbackHistoryCount: sessionFacts.filter((session) => !session.feedbackHistoryFound).length,
      communicationCount: communicationInputs.length,
      communicationInputTruncated,
    },
    sessions: sessionFacts,
    students: studentFacts,
    pendingItems,
  };

  const studentReferences = new Map(students.map((student, index) => [
    `S${String(index + 1).padStart(3, "0")}`,
    { id: student.id, name: student.name, href: `/students/${encodeURIComponent(student.id)}?semesterId=${encodeURIComponent(resolved.semester.id)}` },
  ]));
  const sessionReferences = new Map(sessions.map((session, index) => [
    `X${String(index + 1).padStart(3, "0")}`,
    { id: session.id, code: session.code, date: session.date, href: sessionHref(session) },
  ]));
  const communicationReferences = new Map(communicationInputs.map((communication, index) => [
    `C${String(index + 1).padStart(3, "0")}`,
    {
      ...communication,
      href: `/students/${encodeURIComponent(communication.studentId)}?semesterId=${encodeURIComponent(resolved.semester.id)}`,
    },
  ]));
  const studentRefById = new Map([...studentReferences].map(([ref, student]) => [student.id, ref]));
  const sessionRefById = new Map([...sessionReferences].map(([ref, session]) => [session.id, ref]));

  const promptPayload = {
    facts: {
      scope: facts.scope,
      date: facts.date,
      totals: facts.totals,
      sessions: facts.sessions.map((session) => ({
        ref: sessionRefById.get(session.id),
        className: session.className,
        studentCount: session.studentCount,
        metrics: session.averages,
        presentCount: session.presentCount,
        absentCount: session.absentCount,
        eventCount: session.eventCount,
        pendingDraftCount: session.pendingDraftCount,
        feedbackHistoryFound: session.feedbackHistoryFound,
      })),
      students: facts.students.map((student) => ({
        ref: studentRefById.get(student.id),
        className: student.className,
        selectedComposite: student.selectedComposite,
        previousComposite: student.previousComposite,
        change: student.change,
        eventCount: student.eventCount,
      })),
      pendingItems: facts.pendingItems.map(({ href: _href, ...item }) => item),
    },
    communications: [...communicationReferences].map(([ref, communication]) => ({
      ref,
      studentRef: studentRefById.get(communication.studentId),
      sessionRef: sessionRefById.get(communication.sessionId),
      target: communication.target,
      occurredAt: communication.occurredAt,
      category: communication.category,
      priority: communication.priority,
      summary: communication.summary,
    })),
  };
  const sourceFingerprint = stableHash({ facts, communications: communicationInputs, includeCommunications: request.includeCommunications });
  return {
    facts,
    sourceFingerprint,
    references: {
      students: studentReferences,
      sessions: sessionReferences,
      communications: communicationReferences,
    },
    promptPayload,
    involvedStudentIds: new Set(studentFacts.map((student) => student.id)),
  };
}

function resolveEvidence(
  item: TeachingInterpretation["classComparisons"][number],
  references: ReferenceRegistry,
): TeachingEvidenceItem {
  const students = item.studentRefs.map((ref) => references.students.get(ref));
  const sessions = item.sessionRefs.map((ref) => references.sessions.get(ref));
  const communications = item.communicationRefs.map((ref) => references.communications.get(ref));
  if ([...students, ...sessions, ...communications].some((value) => !value)) {
    throw new Error("llm_reference_invalid");
  }
  return {
    title: item.title,
    detail: item.detail,
    sources: {
      students: students.filter((value): value is NonNullable<typeof value> => Boolean(value)),
      sessions: sessions.filter((value): value is NonNullable<typeof value> => Boolean(value)),
      communications: communications.filter((value): value is NonNullable<typeof value> => Boolean(value)),
    },
  };
}

function resolveInterpretation(value: unknown, references: ReferenceRegistry) {
  const parsed = TeachingInterpretationSchema.parse(value);
  const resolveItems = (items: TeachingInterpretation["classComparisons"]) => (
    items.map((item) => resolveEvidence(item, references))
  );
  const observationCandidates: ResolvedObservationCandidate[] = parsed.observationCandidates.map((candidate) => {
    const student = references.students.get(candidate.studentRef);
    const communications = candidate.communicationRefs.map((ref) => references.communications.get(ref));
    const sessions = candidate.sessionRefs.map((ref) => references.sessions.get(ref));
    if (!student || communications.some((communication) => !communication) || sessions.some((session) => !session)) {
      throw new Error("llm_reference_invalid");
    }
    const validCommunications = communications.filter((value): value is NonNullable<typeof value> => Boolean(value));
    if (validCommunications.some((communication) => communication.studentId !== student.id)) {
      throw new Error("llm_reference_invalid");
    }
    return {
      studentId: student.id,
      kind: candidate.kind,
      topic: candidate.topic,
      title: candidate.title,
      evidenceSummary: candidate.evidenceSummary,
      communicationIds: validCommunications.map((communication) => communication.id),
      relatedSessionId: sessions.find((session) => session)?.id ?? validCommunications[0]?.sessionId ?? null,
    };
  });
  return {
    interpretation: {
      overview: parsed.overview,
      classComparisons: resolveItems(parsed.classComparisons),
      noteworthyChanges: resolveItems(parsed.noteworthyChanges),
      suggestedActions: resolveItems(parsed.suggestedActions),
    } satisfies ResolvedTeachingInterpretation,
    observationCandidates,
  };
}

function parseCachedResult(value: string): ResolvedTeachingInterpretation | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as ResolvedTeachingInterpretation : null;
  } catch {
    return null;
  }
}

async function observationsForContext(context: TeachingSummaryContext, db: PrismaClient) {
  const rows = await listTeacherObservations({ semesterId: context.facts.semester.id, limit: 100 }, db);
  return rows.filter((row) => context.involvedStudentIds.has(row.student.id));
}

export async function getTeachingSummary(
  request: TeachingSummaryRequest,
  db: PrismaClient = prisma,
): Promise<TeachingSummaryBundle> {
  const context = await buildTeachingSummaryContext(request, db);
  const modelName = getLLMModel();
  const cache = await db.teachingSummaryCache.findUnique({
    where: {
      scopeType_scopeKey_includeCommunications: {
        scopeType: request.scope.type,
        scopeKey: context.facts.scopeKey,
        includeCommunications: request.includeCommunications,
      },
    },
  });
  const valid = cache
    && cache.sourceFingerprint === context.sourceFingerprint
    && cache.promptVersion === PROMPT_VERSION
    && cache.modelName === modelName;
  return {
    facts: context.facts,
    analysis: valid ? parseCachedResult(cache.resultJson) : null,
    observations: await observationsForContext(context, db),
    cache: {
      status: valid ? "hit" : cache ? "stale" : "miss",
      generatedAt: cache?.generatedAt.toISOString() ?? null,
    },
  };
}

export async function generateTeachingSummary(
  request: TeachingSummaryRequest,
  db: PrismaClient = prisma,
): Promise<TeachingSummaryBundle> {
  const context = await buildTeachingSummaryContext(request, db);
  const modelName = getLLMModel();
  const existing = await db.teachingSummaryCache.findUnique({
    where: {
      scopeType_scopeKey_includeCommunications: {
        scopeType: request.scope.type,
        scopeKey: context.facts.scopeKey,
        includeCommunications: request.includeCommunications,
      },
    },
  });
  const cacheValid = existing
    && existing.sourceFingerprint === context.sourceFingerprint
    && existing.promptVersion === PROMPT_VERSION
    && existing.modelName === modelName;
  if (cacheValid && !request.forceRefresh) {
    return {
      facts: context.facts,
      analysis: parseCachedResult(existing.resultJson),
      observations: await observationsForContext(context, db),
      cache: { status: "hit", generatedAt: existing.generatedAt.toISOString() },
    };
  }
  if (context.facts.sessions.length === 0) {
    return {
      facts: context.facts,
      analysis: null,
      observations: await observationsForContext(context, db),
      cache: { status: existing ? "stale" : "miss", generatedAt: existing?.generatedAt.toISOString() ?? null },
    };
  }

  const prompt = `你是教师内部教学分析助手。只能依据输入中的确定性事实和已确认沟通摘要工作。
所有数字必须照抄，不得自行计算或补写。每条分析必须引用提供的 S/X/C 短编号。
一般观察不是警告。只有沟通内容与课堂事实有明确呼应、冲突、重复关切、关注升级或未兑现教师承诺时，才输出 observationCandidates。
没有证据时返回空数组。不要输出家长话术，不要评价人格。

输入：
${JSON.stringify(context.promptPayload)}`;

  const raw = await withLLMCacheOperation("daily-report", "生成教师教学总结", async () => {
    const response = await createLLMClient().chat.completions.create({
      model: modelName,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 4096,
      response_format: {
        type: "json_schema",
        json_schema: { name: "teaching_summary", strict: true, schema: interpretationJsonSchema },
      },
    });
    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("llm_output_empty");
    return JSON.parse(content) as unknown;
  });
  const resolved = resolveInterpretation(raw, context.references);
  if (request.includeCommunications) {
    await persistObservationCandidates(db, resolved.observationCandidates, OBSERVATION_VERSION);
  } else if (resolved.observationCandidates.length) {
    throw new Error("llm_reference_invalid");
  }
  const generatedAt = new Date();
  await db.teachingSummaryCache.upsert({
    where: {
      scopeType_scopeKey_includeCommunications: {
        scopeType: request.scope.type,
        scopeKey: context.facts.scopeKey,
        includeCommunications: request.includeCommunications,
      },
    },
    create: {
      scopeType: request.scope.type,
      scopeKey: context.facts.scopeKey,
      includeCommunications: request.includeCommunications,
      sourceFingerprint: context.sourceFingerprint,
      resultJson: JSON.stringify(resolved.interpretation),
      promptVersion: PROMPT_VERSION,
      modelName,
      generatedAt,
    },
    update: {
      sourceFingerprint: context.sourceFingerprint,
      resultJson: JSON.stringify(resolved.interpretation),
      promptVersion: PROMPT_VERSION,
      modelName,
      generatedAt,
    },
  });
  return {
    facts: context.facts,
    analysis: resolved.interpretation,
    observations: await observationsForContext(context, db),
    cache: { status: "hit", generatedAt: generatedAt.toISOString() },
  };
}
