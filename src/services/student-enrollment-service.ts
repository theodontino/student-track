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

export type EnrollmentClassProjection = NonNullable<StudentSemesterProjection["class"]>;

export interface StudentEnrollmentClassChange {
  changed: boolean;
  created: boolean;
  statusChanged: boolean;
  previousClass: EnrollmentClassProjection | null;
  enrollment: {
    id: string;
    studentId: string;
    semesterId: string;
    classId: string;
    rosterStatus: StudentRosterStatus;
    statusEffectiveAt: Date;
    class: EnrollmentClassProjection;
  };
}

const enrollmentWithClassSelect = {
  id: true,
  studentId: true,
  semesterId: true,
  classId: true,
  rosterStatus: true,
  statusEffectiveAt: true,
  class: { select: { id: true, code: true, name: true, semesterId: true } },
} as const;

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

/**
 * Change the current class affiliation for one student and semester.
 *
 * The strict transfer path never creates an enrollment and never changes the
 * roster status. The import/profile path can opt into creating an enrollment
 * and preserving the import's existing reactivation behavior. All paths use
 * the same semester validation and optimistic old-class guard.
 */
export async function changeStudentEnrollmentClass(
  db: EnrollmentDb,
  input: { studentId: string; semesterId: string; classId: string },
  options: { createIfMissing?: boolean; activateExisting?: boolean } = {},
): Promise<StudentEnrollmentClassChange> {
  const student = await db.student.findUnique({ where: { id: input.studentId }, select: { id: true } });
  if (!student) throw new ServiceError("学生不存在", 404);
  const targetClass = await assertClassInSemester(db, input.classId, input.semesterId);
  const current = await db.studentClassEnrollment.findUnique({
    where: { studentId_semesterId: { studentId: input.studentId, semesterId: input.semesterId } },
    select: enrollmentWithClassSelect,
  });

  if (!current) {
    if (!options.createIfMissing) throw new ServiceError("学生在所选学期没有班级归属，不能转班", 409);
    const created = await db.studentClassEnrollment.create({
      data: { studentId: input.studentId, semesterId: input.semesterId, classId: targetClass.id },
      select: enrollmentWithClassSelect,
    });
    return {
      changed: false,
      created: true,
      statusChanged: false,
      previousClass: null,
      enrollment: created,
    };
  }

  const classChanged = current.classId !== targetClass.id;
  const statusChanged = options.activateExisting === true && current.rosterStatus !== "ACTIVE";
  if (!classChanged && !statusChanged) {
    return { changed: false, created: false, statusChanged: false, previousClass: current.class, enrollment: current };
  }

  const guardedWhere = {
    studentId: input.studentId,
    semesterId: input.semesterId,
    classId: current.classId,
    ...(statusChanged ? { rosterStatus: current.rosterStatus } : {}),
  };
  const data = classChanged
    ? (options.activateExisting
      ? { classId: targetClass.id, rosterStatus: "ACTIVE" as const }
      : { classId: targetClass.id })
    : { rosterStatus: "ACTIVE" as const };
  const updated = await db.studentClassEnrollment.updateMany({ where: guardedWhere, data });
  if (updated.count !== 1) {
    throw new ServiceError("学生班级归属已变化，请刷新后重试", 409);
  }

  const enrollment = await db.studentClassEnrollment.findUniqueOrThrow({
    where: { studentId_semesterId: { studentId: input.studentId, semesterId: input.semesterId } },
    select: enrollmentWithClassSelect,
  });
  return {
    changed: classChanged,
    created: false,
    statusChanged,
    previousClass: current.class,
    enrollment,
  };
}

/** Strict one-person transfer: an existing current-semester enrollment is required. */
export async function transferStudentEnrollment(
  db: EnrollmentDb,
  input: { studentId: string; semesterId: string; classId: string },
) {
  return changeStudentEnrollmentClass(db, input);
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
