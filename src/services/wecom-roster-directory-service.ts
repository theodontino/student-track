import { createHash } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { resolveSemester } from "@/services/semester-service";
import { assertClassInSemester } from "@/services/student-enrollment-service";

export async function buildWccRosterSnapshot(
  prisma: PrismaClient,
  semesterId = "",
  classId = "",
) {
  const resolved = await resolveSemester(prisma, semesterId ? { semesterId } : {});
  const resolvedSemesterId = resolved?.id ?? semesterId;
  if (classId && resolvedSemesterId) await assertClassInSemester(prisma, classId, resolvedSemesterId);
  const [classes, semesters, enrollments] = await Promise.all([
    prisma.class.findMany({ where: resolvedSemesterId ? { semesterId: resolvedSemesterId } : undefined, select: { id: true, code: true, name: true, semesterId: true }, orderBy: { code: "asc" } }),
    prisma.semester.findMany({
      where: semesterId ? { id: semesterId } : undefined,
      select: { id: true, name: true, startDate: true, endDate: true },
      orderBy: { startDate: "desc" },
    }),
    prisma.studentClassEnrollment.findMany({
      where: {
        ...(resolvedSemesterId ? { semesterId: resolvedSemesterId } : {}),
        rosterStatus: "ACTIVE",
        ...(classId ? { classId } : {}),
      },
      include: { student: { select: { id: true, name: true, studentId: true } } },
      orderBy: { student: { studentId: "asc" } },
    }),
  ]);
  const body = {
    source: "student-track-api",
    capabilities: ["handoff-revisions-v1"],
    scope: { semesterId: resolvedSemesterId || null, classId: classId || null },
    classes,
    semesters,
    students: enrollments.map((enrollment) => ({
      ...enrollment.student,
      classId: enrollment.classId,
      rosterStatus: enrollment.rosterStatus,
    })),
    sessions: [] as never[],
  };
  const version = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 20);
  return { ...body, version };
}
