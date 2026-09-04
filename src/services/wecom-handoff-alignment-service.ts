import type { PrismaClient } from "@/generated/prisma/client";
import type { WccStudentTrackFileV1 } from "@/lib/contracts/wecom-file-transfer";
import { shanghaiCalendarDate } from "@/services/wecom-session-matcher";

export type WccAlignmentMethod = "explicit" | "remembered" | "title";
export type WccAlignmentReason =
  | "matched"
  | "missing_evidence_date"
  | "no_candidate_semester"
  | "no_student_match"
  | "multiple_student_matches"
  | "remembered_mapping_conflict"
  | "student_semester_conflict";

export interface WccAlignmentResolution {
  studentId: string | null;
  semesterId: string | null;
  candidateSemesterIds: string[];
  method: WccAlignmentMethod | null;
  reason: WccAlignmentReason;
}

export function handoffEvidenceDates(payload: Pick<WccStudentTrackFileV1, "messages">) {
  return [...new Set(payload.messages
    .map((message) => shanghaiCalendarDate(message.sentAt))
    .filter((date): date is string => Boolean(date)))];
}

/**
 * A handoff may fall inside overlapping semester date ranges. The target must
 * cover every evidence date, so use the intersection rather than requiring
 * every date to have one globally unique semester.
 */
export async function candidateSemesterIdsForEvidence(
  prisma: PrismaClient,
  evidenceDates: string[],
) {
  if (evidenceDates.length === 0) return [];
  const semesters = await prisma.semester.findMany({
    where: { deletedAt: null, OR: evidenceDates.map((date) => ({ startDate: { lte: date }, endDate: { gte: date } })) },
    select: { id: true, startDate: true, endDate: true },
  });
  const idsByDate = evidenceDates.map((date) => new Set(
    semesters
      .filter((semester) => date >= semester.startDate && date <= semester.endDate)
      .map((semester) => semester.id),
  ));
  if (idsByDate.some((ids) => ids.size === 0)) return [];
  return [...idsByDate.slice(1).reduce(
    (intersection, ids) => new Set([...intersection].filter((id) => ids.has(id))),
    idsByDate[0],
  )].sort();
}

export async function resolveStudentSemesterInCandidates(
  prisma: PrismaClient,
  studentId: string,
  candidateSemesterIds: string[],
  activeOnly = false,
) {
  if (candidateSemesterIds.length === 0) return null;
  const enrollments = await prisma.studentClassEnrollment.findMany({
    where: {
      studentId,
      semesterId: { in: candidateSemesterIds },
      class: { deletedAt: null, semester: { deletedAt: null } },
      ...(activeOnly ? { rosterStatus: "ACTIVE" as const } : {}),
    },
    select: { semesterId: true },
  });
  const semesterIds = [...new Set(enrollments.map((enrollment) => enrollment.semesterId))];
  return semesterIds.length === 1 ? semesterIds[0] : null;
}

export async function resolveWccHandoffAlignment(
  prisma: PrismaClient,
  input: {
    payload: WccStudentTrackFileV1;
    selectedStudentId?: string;
  },
): Promise<WccAlignmentResolution> {
  const evidenceDates = handoffEvidenceDates(input.payload);
  if (evidenceDates.length === 0) {
    return { studentId: null, semesterId: null, candidateSemesterIds: [], method: null, reason: "missing_evidence_date" };
  }
  const candidateSemesterIds = await candidateSemesterIdsForEvidence(prisma, evidenceDates);
  if (candidateSemesterIds.length === 0) {
    return { studentId: null, semesterId: null, candidateSemesterIds, method: null, reason: "no_candidate_semester" };
  }

  if (input.selectedStudentId) {
    const semesterId = await resolveStudentSemesterInCandidates(
      prisma,
      input.selectedStudentId,
      candidateSemesterIds,
    );
    return semesterId
      ? { studentId: input.selectedStudentId, semesterId, candidateSemesterIds, method: "explicit", reason: "matched" }
      : { studentId: null, semesterId: null, candidateSemesterIds, method: null, reason: "student_semester_conflict" };
  }

  const rememberedRows = await prisma.weComHandoffPackage.findMany({
    where: {
      sourceId: input.payload.source.id,
      conversationId: input.payload.conversation.id,
      selectedStudentId: { not: null },
    },
    select: { selectedStudentId: true },
  });
  const rememberedStudentIds = [...new Set(rememberedRows
    .map((row) => row.selectedStudentId)
    .filter((id): id is string => Boolean(id)))];
  if (rememberedStudentIds.length > 1) {
    return { studentId: null, semesterId: null, candidateSemesterIds, method: null, reason: "remembered_mapping_conflict" };
  }
  if (rememberedStudentIds.length === 1) {
    const semesterId = await resolveStudentSemesterInCandidates(
      prisma,
      rememberedStudentIds[0],
      candidateSemesterIds,
    );
    return semesterId
      ? { studentId: rememberedStudentIds[0], semesterId, candidateSemesterIds, method: "remembered", reason: "matched" }
      : { studentId: null, semesterId: null, candidateSemesterIds, method: null, reason: "remembered_mapping_conflict" };
  }

  const students = await prisma.student.findMany({
    where: {
      enrollments: {
        some: {
          semesterId: { in: candidateSemesterIds },
          rosterStatus: "ACTIVE",
          class: { deletedAt: null, semester: { deletedAt: null } },
        },
      },
    },
    select: {
      id: true,
      name: true,
      enrollments: {
        where: {
          semesterId: { in: candidateSemesterIds },
          rosterStatus: "ACTIVE",
          class: { deletedAt: null, semester: { deletedAt: null } },
        },
        select: { semesterId: true },
      },
    },
  });
  const title = input.payload.conversation.title?.trim() ?? "";
  const matches = title ? students.filter((student) => title.includes(student.name)) : [];
  if (matches.length === 0) {
    return { studentId: null, semesterId: null, candidateSemesterIds, method: null, reason: "no_student_match" };
  }
  if (matches.length > 1) {
    return { studentId: null, semesterId: null, candidateSemesterIds, method: null, reason: "multiple_student_matches" };
  }
  const semesterIds = [...new Set(matches[0].enrollments.map((enrollment) => enrollment.semesterId))];
  if (semesterIds.length !== 1) {
    return { studentId: null, semesterId: null, candidateSemesterIds, method: null, reason: "student_semester_conflict" };
  }
  return {
    studentId: matches[0].id,
    semesterId: semesterIds[0],
    candidateSemesterIds,
    method: "title",
    reason: "matched",
  };
}
