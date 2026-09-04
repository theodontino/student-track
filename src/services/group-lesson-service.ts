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
import { assertSemesterAvailable, assertSessionAvailable } from "@/services/academic-scope-recycle-service";
import { getFeedbackScriptMaterial } from "@/services/feedback-script-library-service";
import { ServiceError } from "@/services/service-error";

type GroupLessonDb = PrismaClient | Prisma.TransactionClient;

const HISTORICAL_UNLINK_ERROR = "该课次记录的是原班级组的历史进度，不能直接解除关联；如需纠正，请改挂到原班级组内的其他共同讲次";

async function invalidateSessionFeedbackPlans(sessionId: string, db: Prisma.TransactionClient) {
  // Loaded lazily to keep feedback-context -> group-lesson-service from forming
  // a runtime import cycle through feedback-plan-service.
  const { invalidateFeedbackPlans } = await import("@/services/feedback-plan-service");
  await invalidateFeedbackPlans({ sessionId }, db);
}

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
    where: { id: { in: classIds }, deletedAt: null, semester: { deletedAt: null } },
    select: { id: true, semesterId: true, classGroupMembership: { select: { groupId: true } } },
  });
  if (classes.length !== classIds.length) throw new ServiceError("有班级不存在", 404);
  if (classes.some((item) => item.semesterId !== semesterId)) throw new ServiceError("班级组只能包含同一学期的班级", 409);
  if (classes.some((item) => item.classGroupMembership && item.classGroupMembership.groupId !== groupId)) {
    throw new ServiceError("有班级已经属于其他班级组", 409);
  }
}

const groupInclude = {
  leadClass: { select: { id: true, code: true, name: true, deletedAt: true } },
  memberships: {
    where: { class: { deletedAt: null, semester: { deletedAt: null } } },
    include: { class: true },
    orderBy: { class: { code: "asc" as const } },
  },
  lessons: {
    orderBy: { sequence: "asc" as const },
    include: {
      revisions: { orderBy: { revision: "desc" as const }, take: 1 },
      sessionLinks: {
        where: {
          session: {
            semester: { deletedAt: null },
            class: { deletedAt: null },
          },
        },
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

function availableClassView(klass: { id: string; code: string; name: string | null; deletedAt: Date | null } | null) {
  if (!klass || klass.deletedAt) return null;
  return { id: klass.id, code: klass.code, name: klass.name };
}

function groupView<T extends {
  leadClassId: string | null;
  leadClass: { id: string; code: string; name: string | null; deletedAt: Date | null } | null;
  lessons: Array<{ materialSnapshot: string; revisions: Array<{ materialSnapshot: string }> }>;
}>(group: T) {
  const leadClass = availableClassView(group.leadClass);
  return {
    ...group,
    leadClassId: leadClass ? group.leadClassId : null,
    leadClass,
    lessons: group.lessons.map(lessonView),
  };
}

export async function listSemesterClassGroups(semesterId: string, db: GroupLessonDb = prisma) {
  await assertSemesterAvailable(semesterId, db);
  const groups = await db.classGroup.findMany({ where: { semesterId }, orderBy: { name: "asc" }, include: groupInclude });
  return groups.filter((group) => group.memberships.length > 0).map(groupView);
}

export async function createClassGroup(semesterId: string, raw: ClassGroupWriteInput, db: PrismaClient = prisma) {
  const input = ClassGroupWriteSchema.parse(raw);
  return db.$transaction(async (tx) => {
    await assertSemesterAvailable(semesterId, tx);
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
    await assertSemesterAvailable(existing.semesterId, tx);
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
  const group = await db.classGroup.findUnique({ where: { id: groupId }, select: { id: true, semesterId: true, _count: { select: { lessons: true } } } });
  if (!group) throw new ServiceError("班级组不存在", 404);
  await assertSemesterAvailable(group.semesterId, db);
  if (group._count.lessons > 0) throw new ServiceError("班级组已有共同课，不能直接删除", 409);
  await db.classGroup.delete({ where: { id: groupId } });
  return { success: true };
}

export async function createGroupLesson(groupId: string, raw: GroupLessonCreateInput, db: PrismaClient = prisma) {
  const input = GroupLessonCreateSchema.parse(raw);
  return db.$transaction(async (tx) => {
    const group = await tx.classGroup.findUnique({ where: { id: groupId }, select: { id: true, semesterId: true } });
    if (!group) throw new ServiceError("班级组不存在", 404);
    await assertSemesterAvailable(group.semesterId, tx);
    const libraryMaterial = lessonMaterialHasContent(input.material)
      ? null
      : await getFeedbackScriptMaterial(tx, group.semesterId, input.sequence);
    const material = libraryMaterial ?? input.material;
    const defaultTitle = `第 ${input.sequence} 讲`;
    const title = input.title === defaultTitle && libraryMaterial?.lessonTitle
      ? libraryMaterial.lessonTitle
      : input.title;
    return tx.groupLesson.create({
      data: { groupId, title, sequence: input.sequence, materialSnapshot: materialJson(material) },
    });
  });
}

export async function reapplyGroupLessonSemesterMaterial(
  lessonId: string,
  replaceExisting: boolean,
  db: PrismaClient = prisma,
) {
  return db.$transaction(async (tx) => {
    const lesson = await tx.groupLesson.findUnique({
      where: { id: lessonId },
      select: {
        id: true,
        title: true,
        sequence: true,
        materialSnapshot: true,
        revision: true,
        confirmedAt: true,
        group: { select: { semesterId: true } },
        revisions: { orderBy: { revision: "desc" }, take: 1, select: { materialSnapshot: true } },
      },
    });
    if (!lesson) throw new ServiceError("共同课不存在", 404);
    await assertSemesterAvailable(lesson.group.semesterId, tx);
    const currentMaterial = parseMaterial(lesson.materialSnapshot);
    if (lessonMaterialHasContent(currentMaterial) && !replaceExisting) {
      throw new ServiceError("当前共同讲次已有内容，重新套用前需要明确确认", 409);
    }
    const material = await getFeedbackScriptMaterial(tx, lesson.group.semesterId, lesson.sequence);
    if (!material) throw new ServiceError(`学期公共材料库中没有第 ${lesson.sequence} 课`, 404);
    const autoTitle = `第 ${lesson.sequence} 讲`;
    const usesPreviousLibraryTitle = Boolean(
      currentMaterial.semesterScriptSource
      && currentMaterial.lessonTitle
      && lesson.title === currentMaterial.lessonTitle,
    );
    const updated = await tx.groupLesson.update({
      where: { id: lesson.id },
      data: {
        materialSnapshot: materialJson(material),
        ...((lesson.title === autoTitle || usesPreviousLibraryTitle) && material.lessonTitle ? { title: material.lessonTitle } : {}),
      },
      select: { id: true, title: true, sequence: true, revision: true, confirmedAt: true, materialSnapshot: true },
    });
    return {
      ...updated,
      material: parseMaterial(updated.materialSnapshot),
      hasUnconfirmedChanges: !lesson.revisions[0] || lesson.revisions[0].materialSnapshot !== updated.materialSnapshot,
    };
  });
}

export async function updateGroupLesson(lessonId: string, raw: GroupLessonUpdateInput, db: PrismaClient = prisma) {
  const input = GroupLessonUpdateSchema.parse(raw);
  return db.$transaction(async (tx) => {
    const existing = await tx.groupLesson.findUnique({
      where: { id: lessonId },
      select: { id: true, sequence: true, group: { select: { semesterId: true } }, _count: { select: { sessionLinks: true } } },
    });
    if (!existing) throw new ServiceError("共同课不存在", 404);
    await assertSemesterAvailable(existing.group.semesterId, tx);
    if (input.sequence !== undefined && input.sequence !== existing.sequence && existing._count.sessionLinks > 0) {
      throw new ServiceError("共同课已关联真实课次，不能修改讲次序号", 409);
    }
    return tx.groupLesson.update({
      where: { id: lessonId },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
        ...(input.material !== undefined ? { materialSnapshot: materialJson(input.material) } : {}),
      },
    });
  });
}

export async function deleteGroupLesson(lessonId: string, db: PrismaClient = prisma) {
  return db.$transaction(async (tx) => {
    const lesson = await tx.groupLesson.findUnique({
      where: { id: lessonId },
      select: {
        id: true,
        group: { select: { semesterId: true } },
        _count: { select: { sessionLinks: true, revisions: true } },
        revisions: { select: { _count: { select: { feedbackPlanBatches: true } } } },
      },
    });
    if (!lesson) throw new ServiceError("共同课不存在", 404);
    await assertSemesterAvailable(lesson.group.semesterId, tx);
    if (lesson._count.sessionLinks > 0) throw new ServiceError("共同课已关联真实课次，不能删除", 409);
    if (lesson.revisions.some((revision) => revision._count.feedbackPlanBatches > 0)) {
      throw new ServiceError("共同课已被反馈批次引用，不能删除", 409);
    }
    if (lesson._count.revisions > 0) throw new ServiceError("共同课已有确认修订，不能删除", 409);
    await tx.groupLesson.delete({ where: { id: lesson.id } });
    return { success: true };
  });
}

export async function confirmGroupLesson(lessonId: string, db: PrismaClient = prisma) {
  return db.$transaction(async (tx) => {
    const lesson = await tx.groupLesson.findUnique({
      where: { id: lessonId },
      include: { group: { select: { semesterId: true } }, revisions: { orderBy: { revision: "desc" }, take: 1 } },
    });
    if (!lesson) throw new ServiceError("共同课不存在", 404);
    await assertSemesterAvailable(lesson.group.semesterId, tx);
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
  return db.$transaction(async (tx) => {
    const lesson = await tx.groupLesson.findUnique({
      where: { id: lessonId },
      include: { group: { include: { memberships: { select: { classId: true } } } } },
    });
    if (!lesson) throw new ServiceError("共同课不存在", 404);
    await assertSemesterAvailable(lesson.group.semesterId, tx);
    const session = await tx.classSession.findUnique({ where: { id: input.sessionId }, select: { id: true, semesterId: true, classId: true } });
    if (!session) throw new ServiceError("课次不存在", 404);
    await assertSessionAvailable(session.id, tx);
    if (session.semesterId !== lesson.group.semesterId || !session.classId || !lesson.group.memberships.some((item) => item.classId === session.classId)) {
      throw new ServiceError("课次不属于该班级组", 409);
    }
    const existing = await tx.groupLessonSession.findUnique({ where: { sessionId: session.id }, select: { groupLessonId: true } });
    if (existing && existing.groupLessonId !== lessonId) throw new ServiceError("该课次已经关联其他共同课", 409);
    const duplicate = await tx.groupLessonSession.findFirst({
      where: { groupLessonId: lessonId, sessionId: { not: session.id }, session: { classId: session.classId } },
      select: { id: true },
    });
    if (duplicate) throw new ServiceError("当前班级已经有真实课次关联到这一讲", 409);
    const link = await tx.groupLessonSession.upsert({
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
    if (!existing) await invalidateSessionFeedbackPlans(session.id, tx);
    return link;
  });
}

export async function unlinkGroupLessonSession(lessonId: string, sessionId: string, db: PrismaClient = prisma) {
  return db.$transaction(async (tx) => {
    const link = await tx.groupLessonSession.findUnique({
      where: { sessionId },
      select: {
        groupLessonId: true,
        groupLesson: { select: { groupId: true, group: { select: { semesterId: true } } } },
        session: {
          select: {
            class: { select: { classGroupMembership: { select: { groupId: true } } } },
          },
        },
      },
    });
    if (!link || link.groupLessonId !== lessonId) throw new ServiceError("共同课课次关联不存在", 404);
    await assertSemesterAvailable(link.groupLesson.group.semesterId, tx);
    await assertSessionAvailable(sessionId, tx);
    if (link.session.class?.classGroupMembership?.groupId !== link.groupLesson.groupId) {
      throw new ServiceError(HISTORICAL_UNLINK_ERROR, 409);
    }
    await tx.groupLessonSession.delete({ where: { sessionId } });
    await invalidateSessionFeedbackPlans(sessionId, tx);
    return { success: true };
  });
}

export async function getSessionGroupProgress(sessionId: string, db: GroupLessonDb = prisma) {
  await assertSessionAvailable(sessionId, db);
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
                  leadClass: { select: { id: true, code: true, name: true, deletedAt: true } },
                  memberships: {
                    where: { class: { deletedAt: null, semester: { deletedAt: null } } },
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
              group: {
                select: {
                  id: true,
                  name: true,
                  leadClassId: true,
                  leadClass: { select: { id: true, code: true, name: true, deletedAt: true } },
                },
              },
              revisions: { orderBy: { revision: "desc" }, take: 1, select: { id: true, revision: true, confirmedAt: true, materialSnapshot: true } },
              sessionLinks: {
                where: {
                  session: {
                    semester: { deletedAt: null },
                    class: { deletedAt: null },
                  },
                },
                select: {
                  session: {
                    select: {
                      id: true,
                      code: true,
                      date: true,
                      classId: true,
                      class: { select: { id: true, code: true, name: true } },
                    },
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
  const rawLesson = session.groupLessonSession?.groupLesson ?? null;
  const currentGroup = session.class?.classGroupMembership?.classGroup;
  const group = rawLesson?.group ?? currentGroup;
  if (!group) return null;
  const leadClass = availableClassView(group.leadClass);
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
  const members = rawLesson
    ? rawLesson.sessionLinks
        .flatMap(({ session: linkedSession }) => linkedSession.class ? [{
          classId: linkedSession.class.id,
          classCode: linkedSession.class.code,
          className: linkedSession.class.name,
          session: {
            id: linkedSession.id,
            code: linkedSession.code,
            date: linkedSession.date,
            classId: linkedSession.classId,
          },
        }] : [])
        .sort((left, right) => left.classCode.localeCompare(right.classCode, "zh-CN", { numeric: true }))
    : (currentGroup?.memberships ?? []).map(({ class: classRecord }) => ({
        classId: classRecord.id,
        classCode: classRecord.code,
        className: classRecord.name,
        session: null,
      }));
  return {
    group: {
      id: group.id,
      name: group.name,
      members,
    },
    leadClass,
    isLeadClass: leadClass?.id === session.classId,
    lesson,
    status: lesson ? "linked" as const : leadClass ? "independent" as const : "lead_required" as const,
  };
}

export async function setSessionGroupProgress(input: { sessionId: string; groupLessonId: string | null }, db: PrismaClient = prisma) {
  await assertSessionAvailable(input.sessionId, db);
  return db.$transaction(async (tx) => {
    const session = await tx.classSession.findUnique({
      where: { id: input.sessionId },
      select: {
        id: true,
        semesterId: true,
        classId: true,
        class: { select: { classGroupMembership: { select: { groupId: true } } } },
        groupLessonSession: {
          select: {
            id: true,
            groupLessonId: true,
            groupLesson: { select: { groupId: true } },
          },
        },
      },
    });
    if (!session?.classId) throw new ServiceError("课次不存在或未关联班级", 404);
    if (!input.groupLessonId) {
      const historicalGroupId = session.groupLessonSession?.groupLesson.groupId;
      const currentGroupId = session.class?.classGroupMembership?.groupId;
      if (historicalGroupId && currentGroupId !== historicalGroupId) {
        throw new ServiceError(HISTORICAL_UNLINK_ERROR, 409);
      }
      const removed = await tx.groupLessonSession.deleteMany({ where: { sessionId: session.id } });
      if (removed.count > 0) await invalidateSessionFeedbackPlans(session.id, tx);
      return { progress: await getSessionGroupProgress(session.id, tx) };
    }
    const lesson = await tx.groupLesson.findUnique({
      where: { id: input.groupLessonId },
      select: { id: true, groupId: true, group: { select: { semesterId: true } } },
    });
    if (!lesson || lesson.group.semesterId !== session.semesterId) throw new ServiceError("共同课不属于课次所在学期", 409);
    const historicalGroupId = session.groupLessonSession?.groupLesson.groupId;
    const allowedGroupId = historicalGroupId ?? session.class?.classGroupMembership?.groupId;
    if (!allowedGroupId || lesson.groupId !== allowedGroupId) {
      throw new ServiceError(
        historicalGroupId ? "历史课次只能在原班级组内调整共同进度" : "共同课不属于当前班级组",
        409,
      );
    }
    if (session.groupLessonSession?.groupLessonId === lesson.id) {
      return { progress: await getSessionGroupProgress(session.id, tx) };
    }
    const duplicate = await tx.groupLessonSession.findFirst({
      where: { groupLessonId: lesson.id, sessionId: { not: session.id }, session: { classId: session.classId } },
      select: { id: true },
    });
    if (duplicate) throw new ServiceError("当前班级已经有真实课次关联到这一讲", 409);
    if (session.groupLessonSession) {
      await tx.groupLessonSession.update({
        where: { sessionId: session.id },
        data: {
          groupLessonId: lesson.id,
          syncStatus: "synced",
          differenceSummary: null,
          comparable: true,
          confirmedAt: new Date(),
        },
      });
    } else {
      await tx.groupLessonSession.create({ data: { groupLessonId: lesson.id, sessionId: session.id, syncStatus: "synced", comparable: true } });
    }
    await invalidateSessionFeedbackPlans(session.id, tx);
    return { progress: await getSessionGroupProgress(session.id, tx) };
  });
}

export async function getConfirmedGroupLessonRevision(revisionId: string, db: GroupLessonDb = prisma) {
  const revision = await db.groupLessonRevision.findUnique({
    where: { id: revisionId },
    include: {
      groupLesson: {
        include: {
          group: true,
          sessionLinks: {
            where: {
              session: {
                semester: { deletedAt: null },
                class: { deletedAt: null },
              },
            },
            include: { session: true },
          },
        },
      },
    },
  });
  if (!revision) throw new ServiceError("已确认共同课修订不存在", 404);
  await assertSemesterAvailable(revision.groupLesson.group.semesterId, db);
  return { ...revision, material: parseMaterial(revision.materialSnapshot) };
}
