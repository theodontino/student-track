import { createHash } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";

export async function buildWccDirectorySnapshot(
  prisma: PrismaClient,
  semesterId = "",
  classId = "",
) {
  const [classes, semesters, students] = await Promise.all([
    prisma.class.findMany({ select: { id: true, code: true, name: true }, orderBy: { code: "asc" } }),
    prisma.semester.findMany({
      where: semesterId ? { id: semesterId } : undefined,
      select: { id: true, name: true, startDate: true, endDate: true },
      orderBy: { startDate: "desc" },
    }),
    prisma.student.findMany({
      where: classId ? { classId } : undefined,
      select: { id: true, name: true, studentId: true, classId: true },
      orderBy: { studentId: "asc" },
    }),
  ]);
  const body = {
    source: "student-track-api",
    scope: { semesterId: semesterId || null, classId: classId || null },
    classes,
    semesters,
    students,
    sessions: [] as never[],
  };
  const version = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 20);
  return { ...body, version };
}
