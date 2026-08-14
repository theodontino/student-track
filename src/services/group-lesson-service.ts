import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import {
  ClassGroupWriteSchema,
  GroupLessonCreateSchema,
  GroupLessonSessionWriteSchema,
  GroupLessonUpdateSchema,
  type ClassGroupWriteInput,
  type GroupLessonCreateInput,
  type GroupLessonSessionWriteInput,
  type GroupLessonUpdateInput,
} from "@/lib/contracts/group-lessons";
import { LessonFeedbackMaterialSchema } from "@/lib/contracts/feedback";
import { createEmptyLessonFeedbackMaterial, lessonMaterialHasContent } from "@/lib/feedback-materials";
import { prisma } from "@/lib/prisma";
import { ServiceError } from "@/services/service-error";

type GroupLessonDb = PrismaClient | Prisma.TransactionClient;

function materialJson(value: unknown) {
  return JSON.stringify(LessonFeedbackMaterialSchema.parse(value));
}

function parseMaterial(value: string) {
  const parsed = (() => { try { return JSON.parse(value) as unknown; } catch { return null; } })();
  return LessonFeedbackMaterialSchema.safeParse(parsed).success
    ? LessonFeedbackMaterialSchema.parse(parsed)
    : createEmptyLessonFeedbackMaterial();
}

async function assertClassesAvailable(db: GroupLessonDb, semesterId: string, classIds: string[], groupId?: string) {
  const classes = await db.class.findMany({
    where: { id: { in: classIds } },
    select: { id: true, semesterId: true, classGroupMembership: { select: { groupId: true } } },
  });
  if (classes.length !== classIds.length) throw new ServiceError("有班级不存在", 404);
  if (classes.some((item) => item.semesterId !== semesterId)) throw new ServiceError("班级组只能包含同一学期的班级", 409);
  if (classes.some((item) => item.classGroupMembership && item.classGroupMembership.groupId !== groupId)) {
    throw new ServiceError("有班级已经属于其他班级组", 409);
  }
}

const groupInclude = {
  leadClass: { select: { id: true, code: true, name: true } },
  memberships: { include: { class: true }, orderBy: { class: { code: "asc" as const } } },
  lessons: {
    orderBy: { sequence: "asc" as const },
    include: {
      revisions: { orderBy: { revision: "desc" as const }, take: 1 },
      sessionLinks: {
        orderBy: { session: { date: "asc" as const } },
        include: { session: { include: { class: { select: { id: true, code: true, name: true } } } } },
      },
    },
  },
} as const;

function lessonView<T extends { materialSnapshot: string; revisions: Array<{ materialSnapshot: string }> }>(lesson: T) {
  const confirmedMaterial = lesson.revisions[0]?.materialSnapshot;
  return {
    ...lesson,
    material: parseMaterial(lesson.materialSnapshot),
    hasUnconfirmedChanges: !confirmedMaterial || confirmedMaterial !== lesson.materialSnapshot,
  };
}

function groupView<T extends { lessons: Array<{ materialSnapshot: string; revisions: Array<{ materialSnapshot: string }> }> }>(group: T) {
  return { ...group, lessons: group.lessons.map(lessonView) };
}

export async function listSemesterClassGroups(semesterId: string, db: GroupLessonDb = prisma) {
  const semester = await db.semester.findUnique({ where: { id: semesterId }, select: { id: true } });
  if (!semester) throw new ServiceError("学期不存在", 404);
  const groups = await db.classGroup.findMany({ where: { semesterId }, orderBy: { name: "asc" }, include: groupInclude });
  return groups.map(groupView);
}

export async function createClassGroup(semesterId: string, raw: ClassGroupWriteInput, db: PrismaClient = prisma) {
  const input = ClassGroupWriteSchema.parse(raw);
  return db.$transaction(async (tx) => {
    const semester = await tx.semester.findUnique({ where: { id: semesterId }, select: { id: true } });
    if (!semester) throw new ServiceError("学期不存在", 404);
    await assertClassesAvailable(tx, semesterId, input.classIds);
    const group = await tx.classGroup.create({
      data: { semesterId, name: input.name, leadClassId: input.leadClassId, memberships: { create: input.classIds.map((classId) => ({ classId })) } },
      include: groupInclude,
    });
    return groupView(group);
  });
}

export async function updateClassGroup(groupId: string, raw: ClassGroupWriteInput, db: PrismaClient = prisma) {
  const input = ClassGroupWriteSchema.parse(raw);
  return db.$transaction(async (tx) => {
    const existing = await tx.classGroup.findUnique({ where: { id: groupId }, select: { id: true, semesterId: true } });
    if (!existing) throw new ServiceError("班级组不存在", 404);
    await assertClassesAvailable(tx, existing.semesterId, input.classIds, groupId);
    await tx.classGroupMembership.deleteMany({ where: { groupId, classId: { notIn: input.classIds } } });
    for (const classId of input.classIds) {
      await tx.classGroupMembership.upsert({
        where: { classId },
        create: { groupId, classId },
        update: { groupId },
      });
    }
    const group = await tx.classGroup.update({ where: { id: groupId }, data: { name: input.name, leadClassId: input.leadClassId }, include: groupInclude });
    return groupView(group);
  });
}

export async function deleteClassGroup(groupId: string, db: PrismaClient = prisma) {
  const group = await db.classGroup.findUnique({ where: { id: groupId }, select: { id: true, _count: { select: { lessons: true } } } });
  if (!group) throw new ServiceError("班级组不存在", 404);
  if (group._count.lessons > 0) throw new ServiceError("班级组已有共同课，不能直接删除", 409);
  await db.classGroup.delete({ where: { id: groupId } });
  return { success: true };
}

export async function createGroupLesson(groupId: string, raw: GroupLessonCreateInput, db: PrismaClient = prisma) {
  const input = GroupLessonCreateSchema.parse(raw);
  const group = await db.classGroup.findUnique({ where: { id: groupId }, select: { id: true } });
  if (!group) throw new ServiceError("班级组不存在", 404);
  return db.groupLesson.create({
    data: { groupId, title: input.title, sequence: input.sequence, materialSnapshot: materialJson(input.material) },
  });
}

export async function updateGroupLesson(lessonId: string, raw: GroupLessonUpdateInput, db: PrismaClient = prisma) {
  const input = GroupLessonUpdateSchema.parse(raw);
  const existing = await db.groupLesson.findUnique({ where: { id: lessonId }, select: { id: true } });
  if (!existing) throw new ServiceError("共同课不存在", 404);
  return db.groupLesson.update({
    where: { id: lessonId },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
      ...(input.material !== undefined ? { materialSnapshot: materialJson(input.material) } : {}),
    },
  });
}

export async function confirmGroupLesson(lessonId: string, db: PrismaClient = prisma) {
  return db.$transaction(async (tx) => {
    const lesson = await tx.groupLesson.findUnique({
      where: { id: lessonId },
      include: { revisions: { orderBy: { revision: "desc" }, take: 1 } },
    });
    if (!lesson) throw new ServiceError("共同课不存在", 404);
    const material = parseMaterial(lesson.materialSnapshot);
    if (!lessonMaterialHasContent(material)) throw new ServiceError("共同课材料为空，不能确认", 409);
    if (lesson.revisions[0]?.materialSnapshot === lesson.materialSnapshot) return lesson.revisions[0];
    const revision = lesson.revision + 1;
    const confirmedAt = new Date();
    const created = await tx.groupLessonRevision.create({
      data: { groupLessonId: lessonId, revision, materialSnapshot: lesson.materialSnapshot, confirmedAt },
    });
    await tx.groupLesson.update({ where: { id: lessonId }, data: { revision, confirmedAt } });
    return created;
  });
}

export async function linkGroupLessonSession(lessonId: string, raw: GroupLessonSessionWriteInput, db: PrismaClient = prisma) {
  const input = GroupLessonSessionWriteSchema.parse(raw);
  const lesson = await db.groupLesson.findUnique({
    where: { id: lessonId },
    include: { group: { include: { memberships: { select: { classId: true } } } } },
  });
  if (!lesson) throw new ServiceError("共同课不存在", 404);
  const session = await db.classSession.findUnique({ where: { id: input.sessionId }, select: { id: true, semesterId: true, classId: true } });
  if (!session) throw new ServiceError("课次不存在", 404);
  if (session.semesterId !== lesson.group.semesterId || !session.classId || !lesson.group.memberships.some((item) => item.classId === session.classId)) {
    throw new ServiceError("课次不属于该班级组", 409);
  }
  const existing = await db.groupLessonSession.findUnique({ where: { sessionId: session.id }, select: { groupLessonId: true } });
  if (existing && existing.groupLessonId !== lessonId) throw new ServiceError("该课次已经关联其他共同课", 409);
  return db.groupLessonSession.upsert({
    where: { sessionId: session.id },
    create: {
      groupLessonId: lessonId,
      sessionId: session.id,
      syncStatus: input.syncStatus,
      differenceSummary: input.differenceSummary || null,
      comparable: input.syncStatus === "not_applicable" ? false : input.comparable,
    },
    update: {
      syncStatus: input.syncStatus,
      differenceSummary: input.differenceSummary || null,
      comparable: input.syncStatus === "not_applicable" ? false : input.comparable,
      confirmedAt: new Date(),
    },
  });
}

export async function unlinkGroupLessonSession(lessonId: string, sessionId: string, db: PrismaClient = prisma) {
  const removed = await db.groupLessonSession.deleteMany({ where: { groupLessonId: lessonId, sessionId } });
  if (!removed.count) throw new ServiceError("共同课课次关联不存在", 404);
  return { success: true };
}

export async function getSessionGroupProgress(sessionId: string, db: GroupLessonDb = prisma) {
  const session = await db.classSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      classId: true,
      class: {
        select: {
          classGroupMembership: {
            select: {
              classGroup: {
                select: {
                  id: true,
                  name: true,
                  leadClassId: true,
                  leadClass: { select: { id: true, code: true, name: true } },
                  memberships: {
                    orderBy: { class: { code: "asc" } },
                    select: { class: { select: { id: true, code: true, name: true } } },
                  },
                },
              },
            },
          },
        },
      },
      groupLessonSession: {
        select: {
          groupLesson: {
            select: {
              id: true,
              title: true,
              sequence: true,
              revision: true,
              confirmedAt: true,
              materialSnapshot: true,
              revisions: { orderBy: { revision: "desc" }, take: 1, select: { id: true, revision: true, confirmedAt: true, materialSnapshot: true } },
              sessionLinks: {
                select: {
                  session: {
                    select: { id: true, code: true, date: true, classId: true },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  if (!session?.classId) return null;
  const group = session.class?.classGroupMembership?.classGroup;
  if (!group) return null;
  const rawLesson = session.groupLessonSession?.groupLesson ?? null;
  const confirmed = rawLesson?.revisions[0] ?? null;
  const lesson = rawLesson ? {
    id: rawLesson.id,
    title: rawLesson.title,
    sequence: rawLesson.sequence,
    revision: rawLesson.revision,
    confirmedAt: rawLesson.confirmedAt,
    revisions: rawLesson.revisions.map((item) => ({ id: item.id, revision: item.revision, confirmedAt: item.confirmedAt })),
    draftMaterial: parseMaterial(rawLesson.materialSnapshot),
    confirmedMaterial: confirmed ? parseMaterial(confirmed.materialSnapshot) : null,
    hasUnconfirmedChanges: !confirmed || confirmed.materialSnapshot !== rawLesson.materialSnapshot,
  } : null;
  const linkedSessionByClass = new Map(
    (rawLesson?.sessionLinks ?? [])
      .filter((link) => Boolean(link.session.classId))
      .map((link) => [link.session.classId as string, link.session]),
  );
  return {
    group: {
      id: group.id,
      name: group.name,
      members: group.memberships.map(({ class: classRecord }) => ({
        classId: classRecord.id,
        classCode: classRecord.code,
        className: classRecord.name,
        session: linkedSessionByClass.get(classRecord.id) ?? null,
      })),
    },
    leadClass: group.leadClass,
    isLeadClass: group.leadClassId === session.classId,
    lesson,
    status: lesson ? "linked" as const : group.leadClassId ? "independent" as const : "lead_required" as const,
  };
}

export async function setSessionGroupProgress(input: { sessionId: string; groupLessonId: string | null }, db: PrismaClient = prisma) {
  return db.$transaction(async (tx) => {
    const session = await tx.classSession.findUnique({
      where: { id: input.sessionId },
      select: { id: true, semesterId: true, classId: true, class: { select: { classGroupMembership: { select: { groupId: true } } } } },
    });
    if (!session?.classId) throw new ServiceError("课次不存在或未关联班级", 404);
    await tx.groupLessonSession.deleteMany({ where: { sessionId: session.id } });
    if (!input.groupLessonId) return { progress: await getSessionGroupProgress(session.id, tx) };
    const lesson = await tx.groupLesson.findUnique({ where: { id: input.groupLessonId }, select: { id: true, groupId: true } });
    if (!lesson || lesson.groupId !== session.class?.classGroupMembership?.groupId) throw new ServiceError("共同课不属于当前班级组", 409);
    const duplicate = await tx.groupLessonSession.findFirst({ where: { groupLessonId: lesson.id, session: { classId: session.classId } }, select: { id: true } });
    if (duplicate) throw new ServiceError("当前班级已经有真实课次关联到这一讲", 409);
    await tx.groupLessonSession.create({ data: { groupLessonId: lesson.id, sessionId: session.id, syncStatus: "synced", comparable: true } });
    return { progress: await getSessionGroupProgress(session.id, tx) };
  });
}

export async function getConfirmedGroupLessonRevision(revisionId: string, db: GroupLessonDb = prisma) {
  const revision = await db.groupLessonRevision.findUnique({
    where: { id: revisionId },
    include: { groupLesson: { include: { group: true, sessionLinks: { include: { session: true } } } } },
  });
  if (!revision) throw new ServiceError("已确认共同课修订不存在", 404);
  return { ...revision, material: parseMaterial(revision.materialSnapshot) };
}
