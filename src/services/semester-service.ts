import type { PrismaClient } from "@/generated/prisma/client";
import { ServiceError } from "@/services/service-error";

export interface ResolvedSemester {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
}

export interface SemesterResolutionOptions {
  semesterId?: string;
  now?: Date;
}

export function localDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Resolves an explicit semester or the best current fallback used by read-only summaries. */
export async function resolveSemester(
  db: PrismaClient,
  options: SemesterResolutionOptions = {},
): Promise<ResolvedSemester | null> {
  const select = { id: true, name: true, startDate: true, endDate: true } as const;
  if (options.semesterId) {
    const semester = await db.semester.findUnique({ where: { id: options.semesterId }, select });
    if (!semester) throw new ServiceError("学期不存在", 404);
    return semester;
  }

  const today = localDate(options.now ?? new Date());
  const active = await db.semester.findFirst({
    where: { startDate: { lte: today }, endDate: { gte: today } },
    orderBy: [{ startDate: "desc" }, { createdAt: "desc" }],
    select,
  });
  if (active) return active;

  const latestSession = await db.classSession.findFirst({
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    select: { semester: { select } },
  });
  if (latestSession) return latestSession.semester;

  return db.semester.findFirst({
    orderBy: [{ startDate: "desc" }, { createdAt: "desc" }],
    select,
  });
}
