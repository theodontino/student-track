import type { PrismaClient } from "@/generated/prisma/client";
import {
  ObservationStatusSchema,
  type ObservationKind,
  type ObservationStatus,
} from "@/lib/contracts/teaching-summary";
import { ApiError } from "@/lib/api-errors";
import { parseFeedbackCommunicationSummary } from "@/lib/feedback-communication";
import { prisma } from "@/lib/prisma";
import { assertClassAvailable, assertSemesterAvailable } from "@/services/academic-scope-recycle-service";

export interface ResolvedObservationCandidate {
  studentId: string;
  kind: ObservationKind;
  topic: string;
  title: string;
  evidenceSummary: string;
  communicationIds: string[];
  relatedSessionId: string | null;
}

function observationKey(input: { studentId: string; kind: string; topic: string }) {
  return `${input.studentId}\0${input.kind}\0${input.topic}`;
}

export async function persistObservationCandidates(
  db: PrismaClient,
  candidates: ResolvedObservationCandidate[],
  analysisVersion: string,
) {
  if (candidates.length === 0) return [];
  const studentIds = [...new Set(candidates.map((candidate) => candidate.studentId))];
  const existing = await db.teacherObservation.findMany({
    where: { studentId: { in: studentIds } },
    include: { sources: { select: { communicationId: true } } },
  });
  const existingByKey = new Map(existing.map((item) => [observationKey(item), item]));

  return db.$transaction(async (tx) => {
    const saved = [];
    for (const candidate of candidates) {
      const previous = existingByKey.get(observationKey(candidate));
      const previousSourceIds = new Set(previous?.sources.map((source) => source.communicationId) ?? []);
      const sourceIds = [...new Set(candidate.communicationIds)];
      const newSourceIds = sourceIds.filter((id) => !previousSourceIds.has(id));
      const hasNewEvidence = newSourceIds.length > 0;
      const now = new Date();
      const nextStatus = previous && hasNewEvidence && ["handled", "ignored"].includes(previous.status)
        ? "new"
        : previous?.status ?? "new";
      const observation = previous
        ? await tx.teacherObservation.update({
            where: { id: previous.id },
            data: {
              title: candidate.title,
              evidenceSummary: candidate.evidenceSummary,
              analysisVersion,
              ...(hasNewEvidence ? { lastDetectedAt: now } : {}),
              ...(nextStatus !== previous.status ? { status: nextStatus, statusChangedAt: now } : {}),
            },
          })
        : await tx.teacherObservation.create({
            data: {
              studentId: candidate.studentId,
              kind: candidate.kind,
              topic: candidate.topic,
              title: candidate.title,
              evidenceSummary: candidate.evidenceSummary,
              status: "new",
              analysisVersion,
            },
          });
      if (newSourceIds.length > 0) {
        await tx.teacherObservationSource.createMany({
          data: newSourceIds.map((communicationId) => ({
            observationId: observation.id,
            communicationId,
            relatedSessionId: candidate.relatedSessionId,
          })),
        });
      }
      if (previous && nextStatus !== previous.status) {
        await tx.systemLog.create({
          data: {
            action: "teacher_observation.reopened",
            targetType: "TeacherObservation",
            targetId: observation.id,
            targetName: candidate.title,
            detail: JSON.stringify({ previousStatus: previous.status, status: nextStatus }),
          },
        });
      }
      saved.push(observation);
    }
    return saved;
  });
}

export interface ListTeacherObservationOptions {
  observationId?: string;
  semesterId?: string;
  classId?: string;
  studentIds?: string[];
  statuses?: ObservationStatus[];
  limit?: number;
}

export async function listTeacherObservations(
  options: ListTeacherObservationOptions = {},
  db: PrismaClient = prisma,
) {
  if (options.classId) {
    const klass = await assertClassAvailable(options.classId, db);
    if (options.semesterId && klass.semesterId !== options.semesterId) {
      throw new ApiError("班级不属于所选学期", 409, "conflict", false);
    }
  } else if (options.semesterId) {
    await assertSemesterAvailable(options.semesterId, db);
  }
  const statuses = options.statuses?.map((status) => ObservationStatusSchema.parse(status));
  const availableSessionWhere = {
    ...(options.semesterId ? { semesterId: options.semesterId } : {}),
    semester: { deletedAt: null },
    OR: [{ classId: null }, { class: { deletedAt: null } }],
  };
  const rows = await db.teacherObservation.findMany({
    where: {
      ...(options.observationId ? { id: options.observationId } : {}),
      ...(statuses?.length ? { status: { in: statuses } } : {}),
      ...(options.classId ? {
        student: {
          enrollments: {
            some: {
              classId: options.classId,
              ...(options.semesterId ? { semesterId: options.semesterId } : {}),
              semester: { deletedAt: null },
              class: { deletedAt: null },
            },
          },
        },
      } : {}),
      ...(options.studentIds?.length ? { studentId: { in: options.studentIds } } : {}),
      sources: {
        some: { communication: { session: availableSessionWhere } },
      },
    },
    orderBy: [{ status: "asc" }, { lastDetectedAt: "desc" }],
    take: Math.max(1, Math.min(options.limit ?? 50, 1000)),
    include: {
      student: {
        select: {
          id: true,
          name: true,
          studentId: true,
          enrollments: {
            where: {
              ...(options.semesterId ? { semesterId: options.semesterId } : {}),
              ...(options.classId ? { classId: options.classId } : {}),
              semester: { deletedAt: null },
              class: { deletedAt: null },
            },
            include: { class: { select: { id: true, code: true, name: true } } },
          },
        },
      },
      sources: {
        where: { communication: { session: availableSessionWhere } },
        orderBy: { createdAt: "desc" },
        include: {
          communication: {
            select: {
              id: true,
              target: true,
              summary: true,
              occurredAt: true,
              createdAt: true,
              session: { select: { id: true, code: true, date: true, semesterId: true } },
            },
          },
          relatedSession: { select: { id: true, code: true, date: true } },
        },
      },
    },
  });
  return rows.flatMap((row) => {
    const validSources = row.sources.filter((source) => (
      !options.semesterId || source.communication.session.semesterId === options.semesterId
    ));
    if (validSources.length === 0) return [];
    return [{
      id: row.id,
      kind: row.kind,
      topic: row.topic,
      title: row.title,
      evidenceSummary: row.evidenceSummary,
      status: ObservationStatusSchema.parse(row.status),
      analysisVersion: row.analysisVersion,
      firstDetectedAt: row.firstDetectedAt.toISOString(),
      lastDetectedAt: row.lastDetectedAt.toISOString(),
      statusChangedAt: row.statusChangedAt.toISOString(),
      student: {
        id: row.student.id,
        name: row.student.name,
        studentId: row.student.studentId,
        classId: row.student.enrollments[0]?.class.id ?? null,
        className: row.student.enrollments[0]?.class.name ?? row.student.enrollments[0]?.class.code ?? "",
        href: `/students/${encodeURIComponent(row.student.id)}`,
      },
      sources: validSources.map((source) => {
        const parsed = parseFeedbackCommunicationSummary(source.communication.summary);
        return {
          communicationId: source.communication.id,
          target: source.communication.target,
          summary: parsed.summary,
          occurredAt: source.communication.occurredAt || parsed.occurredAt || source.communication.session.date || source.communication.createdAt.toISOString(),
          sessionCode: source.communication.session.code,
          sessionDate: source.communication.session.date,
          relatedSessionCode: source.relatedSession?.code ?? null,
          studentHref: `/students/${encodeURIComponent(row.student.id)}?semesterId=${encodeURIComponent(source.communication.session.semesterId)}`,
          sessionHref: `/quick-score?semesterId=${encodeURIComponent(source.communication.session.semesterId)}&sessionCode=${encodeURIComponent(source.communication.session.code)}`,
        };
      }),
    }];
  });
}

export async function updateTeacherObservationStatus(
  id: string,
  status: ObservationStatus,
  db: PrismaClient = prisma,
) {
  const validatedStatus = ObservationStatusSchema.parse(status);
  const current = await db.teacherObservation.findUnique({ where: { id } });
  if (!current) throw new Error("observation_not_found");
  const visible = (await listTeacherObservations({ observationId: id }, db))[0];
  if (!visible) {
    throw new ApiError("观察所属范围位于回收站，当前不可用", 409, "scope_in_recycle_bin", false);
  }
  if (current.status === validatedStatus) {
    return visible;
  }
  await db.$transaction([
    db.teacherObservation.update({
      where: { id },
      data: { status: validatedStatus, statusChangedAt: new Date() },
    }),
    db.systemLog.create({
      data: {
        action: "teacher_observation.status_changed",
        targetType: "TeacherObservation",
        targetId: id,
        targetName: current.title,
        detail: JSON.stringify({ previousStatus: current.status, status: validatedStatus }),
      },
    }),
  ]);
  return (await listTeacherObservations({ observationId: id, statuses: [validatedStatus] }, db))[0] ?? null;
}
