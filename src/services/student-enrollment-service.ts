import type { Prisma, PrismaClient, StudentRosterStatus } from "@/generated/prisma/client";
import { resolveSemester } from "@/services/semester-service";
import { ServiceError } from "@/services/service-error";

/** A Prisma client or the transaction client used by roster writes. */
export type EnrollmentDb = PrismaClient | Prisma.TransactionClient;

export interface StudentSemesterProjection {
  classId: string | null;
  classCode: string | null;
  class: { id: string; code: string; name: string | null; semesterId: string } | null;
  rosterStatus: StudentRosterStatus | null;
  statusEffectiveAt: Date | null;
}

/** Resolve an explicit semester, or the same current/latest fallback used by the app. */
export async function requireSemesterId(
  db: EnrollmentDb,
  semesterId?: string | null,
): Promise<string> {
  const semester = await resolveSemester(db as PrismaClient, { semesterId: semesterId ?? undefined });
  if (!semester) throw new ServiceError("尚未建立学期，无法执行班级或名单操作", 409);
  return semester.id;
}

export async function assertClassInSemester(
  db: EnrollmentDb,
  classId: string,
  semesterId: string,
) {
  const klass = await db.class.findUnique({
    where: { id: classId },
    select: { id: true, code: true, name: true, semesterId: true },
  });
  if (!klass) throw new ServiceError("班级不存在", 404);
  if (klass.semesterId !== semesterId) {
    throw new ServiceError("班级不属于所选学期", 409);
  }
  return klass;
}

export async function findClassBySemesterCode(
  db: EnrollmentDb,
  semesterId: string,
  code: string,
) {
  return db.class.findUnique({
    where: { semesterId_code: { semesterId, code } },
    select: { id: true, code: true, name: true, semesterId: true },
  });
}

export async function listSemesterClasses(db: EnrollmentDb, semesterId: string) {
  const classes = await db.class.findMany({
    where: { semesterId },
    orderBy: [{ code: "asc" }, { name: "asc" }],
    include: {
      enrollments: {
        where: { semesterId },
        select: { rosterStatus: true },
      },
      sessions: { select: { id: true } },
    },
  });
  return classes.map(({ enrollments, sessions, ...klass }) => ({
    ...klass,
    activeStudentCount: enrollments.filter((enrollment) => enrollment.rosterStatus === "ACTIVE").length,
    inactiveStudentCount: enrollments.filter((enrollment) => enrollment.rosterStatus === "INACTIVE").length,
    sessionCount: sessions.length,
  }));
}

export async function getStudentEnrollment(
  db: EnrollmentDb,
  studentId: string,
  semesterId: string,
) {
  return db.studentClassEnrollment.findUnique({
    where: { studentId_semesterId: { studentId, semesterId } },
    include: { class: true, semester: true },
  });
}

export async function upsertStudentEnrollment(
  db: EnrollmentDb,
  input: {
    studentId: string;
    semesterId: string;
    classId: string;
    rosterStatus?: StudentRosterStatus;
    statusEffectiveAt?: Date;
  },
) {
  await assertClassInSemester(db, input.classId, input.semesterId);
  const data = {
    classId: input.classId,
    ...(input.rosterStatus ? { rosterStatus: input.rosterStatus } : {}),
    ...(input.statusEffectiveAt ? { statusEffectiveAt: input.statusEffectiveAt } : {}),
  };
  return db.studentClassEnrollment.upsert({
    where: { studentId_semesterId: { studentId: input.studentId, semesterId: input.semesterId } },
    create: {
      studentId: input.studentId,
      semesterId: input.semesterId,
      ...data,
    },
    update: data,
    include: { class: true, semester: true },
  });
}

export async function listSemesterStudentIds(
  db: EnrollmentDb,
  input: { semesterId: string; classId?: string; activeOnly?: boolean },
) {
  const enrollments = await db.studentClassEnrollment.findMany({
    where: {
      semesterId: input.semesterId,
      ...(input.classId ? { classId: input.classId } : {}),
      ...(input.activeOnly ? { rosterStatus: "ACTIVE" } : {}),
    },
    select: { studentId: true },
  });
  return enrollments.map((item) => item.studentId);
}

export function semesterStudentWhere(input: {
  semesterId: string;
  classId?: string;
  activeOnly?: boolean;
  studentIds?: string[];
}): Prisma.StudentWhereInput {
  return {
    ...(input.studentIds ? { id: { in: input.studentIds } } : {}),
    enrollments: {
      some: {
        semesterId: input.semesterId,
        ...(input.classId ? { classId: input.classId } : {}),
        ...(input.activeOnly ? { rosterStatus: "ACTIVE" } : {}),
      },
    },
  };
}

export function projectStudentEnrollment(
  enrollments: Array<{
    class: { id: string; code: string; name: string | null; semesterId: string };
    rosterStatus: StudentRosterStatus;
    statusEffectiveAt: Date;
  }>,
): StudentSemesterProjection {
  const enrollment = enrollments[0];
  if (!enrollment) {
    return {
      classId: null,
      classCode: null,
      class: null,
      rosterStatus: null,
      statusEffectiveAt: null,
    };
  }
  return {
    classId: enrollment.class.id,
    classCode: enrollment.class.code,
    class: enrollment.class,
    rosterStatus: enrollment.rosterStatus,
    statusEffectiveAt: enrollment.statusEffectiveAt,
  };
}

export async function assertStudentsBelongToSession(
  db: EnrollmentDb,
  input: { sessionId: string; studentIds: string[] },
) {
  const session = await db.classSession.findUnique({
    where: { id: input.sessionId },
    select: { id: true, semesterId: true, classId: true },
  });
  if (!session) throw new ServiceError("课次不存在", 404);
  if (!session.classId || input.studentIds.length === 0) return session;
  const count = await db.studentClassEnrollment.count({
    where: {
      semesterId: session.semesterId,
      classId: session.classId,
      rosterStatus: "ACTIVE",
      studentId: { in: input.studentIds },
    },
  });
  if (count !== new Set(input.studentIds).size) {
    throw new ServiceError("存在不属于该课次学期班级的学生", 409);
  }
  return session;
}
