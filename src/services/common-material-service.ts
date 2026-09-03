import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { LessonFeedbackMaterialSchema } from "@/lib/contracts/feedback";
import { createEmptyLessonFeedbackMaterial, type LessonFeedbackMaterial } from "@/lib/feedback-materials";
import { prisma } from "@/lib/prisma";
import { getFeedbackScriptMaterial } from "@/services/feedback-script-library-service";
import { ServiceError } from "@/services/service-error";
import { assertSemesterAvailable, assertSessionAvailable } from "@/services/academic-scope-recycle-service";

type CommonMaterialDb = PrismaClient | Prisma.TransactionClient;

function parseMaterial(raw: string | null | undefined, sessionCode = "") {
  if (!raw) return null;
  try {
    const parsed = LessonFeedbackMaterialSchema.safeParse(JSON.parse(raw));
    return parsed.success ? { ...parsed.data, sessionCode: parsed.data.sessionCode || sessionCode } : null;
  } catch {
    return null;
  }
}

function materialForSession(material: LessonFeedbackMaterial, sessionCode: string) {
  return sessionCode ? { ...material, sessionCode } : material;
}

/** Resolve a semester script without writing it or confirming it. */
export async function resolveSemesterCommonMaterial(
  db: CommonMaterialDb,
  semesterId: string,
  lessonNumber: number,
  sessionCode = "",
) {
  const material = await getFeedbackScriptMaterial(db, semesterId, lessonNumber);
  return material ? materialForSession(material, sessionCode) : null;
}

/** Save a script-derived draft on a GroupLesson. This never creates a revision. */
export async function setGroupLessonCommonMaterial(
  lessonId: string,
  lessonNumber: number | null,
  db: CommonMaterialDb,
) {
  const lesson = await db.groupLesson.findUnique({
    where: { id: lessonId },
    select: { id: true, sequence: true, materialSnapshot: true, group: { select: { semesterId: true } } },
  });
  if (!lesson) throw new ServiceError("共同课不存在", 404);
  await assertSemesterAvailable(lesson.group.semesterId, db);
  const material = lessonNumber === null
    ? createEmptyLessonFeedbackMaterial()
    : await resolveSemesterCommonMaterial(db, lesson.group.semesterId, lessonNumber);
  if (lessonNumber !== null && !material) throw new ServiceError(`学期公共材料库没有第 ${lessonNumber} 课`, 404);
  const next = material ?? createEmptyLessonFeedbackMaterial();
  const updated = await db.groupLesson.update({
    where: { id: lessonId },
    data: { materialSnapshot: JSON.stringify(next) },
    select: { id: true, title: true, sequence: true, revision: true, confirmedAt: true, materialSnapshot: true },
  });
  return { ...updated, material: next, hasUnconfirmedChanges: true };
}

/** Save or clear a public material snapshot for an independent ClassSession. */
export async function setSessionCommonMaterial(
  sessionId: string,
  lessonNumber: number | null,
  db: CommonMaterialDb,
) {
  const session = await db.classSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      code: true,
      semesterId: true,
      groupLessonSession: { select: { groupLessonId: true } },
    },
  });
  if (!session) throw new ServiceError("课次不存在", 404);
  await assertSessionAvailable(session.id, db);
  if (session.groupLessonSession) throw new ServiceError("当前课次已关联共同课，请在共同课材料中调整", 409);
  const material = lessonNumber === null
    ? null
    : await resolveSemesterCommonMaterial(db, session.semesterId, lessonNumber, session.code);
  if (lessonNumber !== null && !material) throw new ServiceError(`学期公共材料库没有第 ${lessonNumber} 课`, 404);
  const updated = await db.classSession.update({
    where: { id: session.id },
    data: {
      commonMaterialSnapshot: material ? JSON.stringify(material) : null,
      commonMaterialConfirmedAt: material ? new Date() : null,
    },
    select: { id: true, code: true, commonMaterialSnapshot: true, commonMaterialConfirmedAt: true },
  });
  return {
    ...updated,
    material: parseMaterial(updated.commonMaterialSnapshot, updated.code),
  };
}

export async function getSessionCommonMaterial(sessionId: string, db: CommonMaterialDb = prisma) {
  const session = await db.classSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      code: true,
      commonMaterialSnapshot: true,
      commonMaterialConfirmedAt: true,
      groupLessonSession: { select: { groupLessonId: true } },
    },
  });
  if (!session) return null;
  return {
    linkedGroupLessonId: session.groupLessonSession?.groupLessonId ?? null,
    confirmedAt: session.commonMaterialConfirmedAt,
    material: parseMaterial(session.commonMaterialSnapshot, session.code),
  };
}
