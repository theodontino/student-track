import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { archiveMetricBeforeUpdate } from "@/lib/archive";
import type {
  GroupProgressIntent,
  SessionCreationLessonOption,
  SessionCreationOptions,
  SessionCreationRecommendation,
} from "@/lib/contracts/session-creation";
import { logAction } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { recalculateScoreDForStudents } from "@/lib/scoreD";
import { ServiceError } from "@/services/service-error";
import { invalidateFeedbackPlans } from "@/services/feedback-plan-service";
import { assertClassInSemester } from "@/services/student-enrollment-service";
import { resolveSemesterCommonMaterial } from "@/services/common-material-service";

type SessionDb = PrismaClient | Prisma.TransactionClient;

function localDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function reorderSemesterNumbers(
  tx: Prisma.TransactionClient,
  semesterId: string,
  classId: string | null,
) {
  const sessions = await tx.classSession.findMany({
    where: { semesterId, classId },
    orderBy: { code: "asc" },
    select: { id: true },
  });
  for (let index = 0; index < sessions.length; index++) {
    await tx.classSession.update({
      where: { id: sessions[index].id },
      data: { semesterNumber: index + 1 },
    });
  }
}

async function resolveSelectedClass(
  db: SessionDb,
  input: { semesterId: string; classId?: string; classCode?: string },
) {
  let selectedClass = input.classId
    ? await assertClassInSemester(db, input.classId, input.semesterId)
    : null;
  if (!selectedClass && input.classCode) {
    const matches = await db.class.findMany({
      where: {
        semesterId: input.semesterId,
        OR: [{ code: input.classCode }, { name: input.classCode }],
      },
      select: { id: true, code: true, name: true, semesterId: true },
    });
    if (matches.length > 1) throw new ServiceError("班级名称不唯一，请使用 classId", 409);
    selectedClass = matches[0] ?? null;
  }
  if (input.classCode && !selectedClass) throw new ServiceError("班级不存在", 404);
  return selectedClass;
}

async function getClassSessionCreationOptionsFromDb(
  db: SessionDb,
  input: { semesterId: string; classId?: string; classCode?: string; date: string },
): Promise<SessionCreationOptions> {
  const semester = await db.semester.findUnique({
    where: { id: input.semesterId },
    select: { id: true },
  });
  if (!semester) throw new ServiceError("学期不存在", 404);

  const selectedClass = await resolveSelectedClass(db, input);
  const classView = selectedClass
    ? { id: selectedClass.id, code: selectedClass.code, name: selectedClass.name }
    : null;
  if (!selectedClass) {
    return {
      date: input.date,
      class: null,
      group: null,
      lessons: [],
      recommendation: { type: "independent", reason: "未选择班级，将建立全校独立课次" },
    };
  }

  const membership = await db.classGroupMembership.findUnique({
    where: { classId: selectedClass.id },
    select: {
      classGroup: {
        select: {
          id: true,
          name: true,
          leadClassId: true,
          leadClass: { select: { id: true, code: true, name: true } },
          lessons: {
            orderBy: { sequence: "asc" },
            select: {
              id: true,
              title: true,
              sequence: true,
              sessionLinks: {
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
  const group = membership?.classGroup;
  if (!group) {
    return {
      date: input.date,
      class: classView,
      group: null,
      lessons: [],
      recommendation: { type: "independent", reason: "该班级不属于班级组，将建立独立课次" },
    };
  }

  const isLeadClass = group.leadClassId === selectedClass.id;
  const availableLessons: SessionCreationLessonOption[] = group.lessons.flatMap((lesson) => {
    const alreadyLinked = lesson.sessionLinks.some(({ session }) => session.classId === selectedClass.id);
    if (alreadyLinked) return [];
    return [{
      id: lesson.id,
      title: lesson.title,
      sequence: lesson.sequence,
      started: lesson.sessionLinks.length > 0,
      linkedClasses: lesson.sessionLinks.flatMap(({ session }) => session.class ? [{
        id: session.class.id,
        code: session.class.code,
        name: session.class.name,
        sessionId: session.id,
        sessionDate: session.date,
      }] : []),
    }];
  });
  const classLinks = group.lessons.flatMap((lesson) => lesson.sessionLinks
    .filter(({ session }) => session.classId === selectedClass.id)
    .map(({ session }) => ({ lesson, session })));
  const highestLinked = classLinks
    .slice()
    .sort((left, right) => right.lesson.sequence - left.lesson.sequence)[0] ?? null;
  const latestClassSession = await db.classSession.findFirst({
    where: { semesterId: input.semesterId, classId: selectedClass.id },
    orderBy: [{ date: "desc" }, { code: "desc" }],
    select: { id: true, date: true, groupLessonSession: { select: { groupLessonId: true } } },
  });
  const startedLessons = group.lessons.filter((lesson) => lesson.sessionLinks.length > 0);
  const maxSequence = group.lessons.at(-1)?.sequence ?? 0;

  let recommendation: SessionCreationRecommendation;
  if (!group.leadClassId) {
    recommendation = { type: "choice_required", reason: "班级组尚未设置进度基准班，请先明确选择共同讲次或建立独立课次" };
  } else if (latestClassSession && input.date < latestClassSession.date) {
    recommendation = { type: "choice_required", reason: `所选日期早于该班最近课次（${latestClassSession.date}），回填课次需要明确选择共同讲次或独立课次` };
  } else if (highestLinked && latestClassSession && latestClassSession.id !== highestLinked.session.id && !latestClassSession.groupLessonSession) {
    recommendation = { type: "choice_required", reason: "该班最近一次课为独立课次，共同进度需要由教师明确继续位置" };
  } else if (!highestLinked && startedLessons.length > 0) {
    recommendation = { type: "choice_required", reason: "该班尚无共同进度，但班级组已经开课，请明确选择本班起始讲次" };
  } else if (isLeadClass) {
    const nextExisting = availableLessons.find((lesson) => !highestLinked || lesson.sequence > highestLinked.lesson.sequence);
    recommendation = nextExisting
      ? { type: "existing", reason: `建议进入共同第 ${nextExisting.sequence} 讲`, lesson: { id: nextExisting.id, title: nextExisting.title, sequence: nextExisting.sequence } }
      : { type: "new", reason: `建议由进度基准班开始共同第 ${maxSequence + 1} 讲`, nextSequence: maxSequence + 1 };
  } else {
    const nextStarted = availableLessons.find((lesson) => (
      lesson.started && (!highestLinked || lesson.sequence > highestLinked.lesson.sequence)
    ));
    recommendation = nextStarted
      ? { type: "existing", reason: `建议进入已经开始的共同第 ${nextStarted.sequence} 讲`, lesson: { id: nextStarted.id, title: nextStarted.title, sequence: nextStarted.sequence } }
      : { type: "waiting", reason: "进度基准班尚未开始下一讲，可建立独立课次或稍后再关联" };
  }

  return {
    date: input.date,
    class: classView,
    group: {
      id: group.id,
      name: group.name,
      leadClass: group.leadClass,
      isLeadClass,
    },
    lessons: availableLessons,
    recommendation,
  };
}

/** Returns the choices shown before a session is created; it never changes progress. */
export async function getClassSessionCreationOptions(input: {
  semesterId: string;
  classId?: string;
  classCode?: string;
  date?: string;
}) {
  return getClassSessionCreationOptionsFromDb(prisma, { ...input, date: input.date ?? localDate() });
}

/** Creates a session, its initial attendance roster, and derived D scores atomically. */
export async function createClassSession(input: {
  semesterId: string;
  classId?: string;
  classCode?: string;
  date?: string;
  requestKey?: string;
  groupProgressIntent?: GroupProgressIntent;
  commonMaterialLessonNumber?: number | null;
}) {
  const date = input.date ?? localDate();
  const result = await prisma.$transaction(async (tx) => {
    const semester = await tx.semester.findUnique({
      where: { id: input.semesterId },
      select: { id: true },
    });
    if (!semester) throw new ServiceError("学期不存在", 404);

    const selectedClass = await resolveSelectedClass(tx, input);
    const classId = selectedClass?.id ?? null;
    const creationRequestSnapshot = JSON.stringify({
      semesterId: input.semesterId,
      classId,
      date,
      groupProgressIntent: input.groupProgressIntent ?? null,
      commonMaterialLessonNumber: input.commonMaterialLessonNumber ?? null,
    });
    if (input.requestKey) {
      const existing = await tx.classSession.findUnique({
        where: { creationRequestKey: input.requestKey },
        select: {
          id: true,
          code: true,
          semesterId: true,
          semesterNumber: true,
          date: true,
          classId: true,
          commonMaterialSnapshot: true,
          commonMaterialConfirmedAt: true,
          createdAt: true,
          creationRequestSnapshot: true,
          class: { select: { code: true, name: true } },
          _count: { select: { attendances: true } },
        },
      });
      if (existing) {
        if (existing.creationRequestSnapshot !== creationRequestSnapshot) {
          throw new ServiceError("同一建课请求不能用于不同的课次内容", 409);
        }
        return {
          session: {
            id: existing.id,
            code: existing.code,
            semesterId: existing.semesterId,
            semesterNumber: existing.semesterNumber,
            date: existing.date,
            classId: existing.classId,
            commonMaterialSnapshot: existing.commonMaterialSnapshot,
            commonMaterialConfirmedAt: existing.commonMaterialConfirmedAt,
            createdAt: existing.createdAt,
          },
          studentCount: existing._count.attendances,
          className: existing.class?.name ?? existing.class?.code,
          groupProgress: null,
          replayed: true,
        };
      }
    }
    const creationOptions = await getClassSessionCreationOptionsFromDb(tx, {
      semesterId: input.semesterId,
      classId: classId ?? undefined,
      date,
    });
    if (creationOptions.group && !input.groupProgressIntent) {
      throw new ServiceError("组内班级建课前必须明确选择共同进度或独立课次", 400);
    }
    if (!creationOptions.group && input.groupProgressIntent?.type === "lesson") {
      throw new ServiceError("当前班级不属于班级组，不能关联共同课", 409);
    }

    const dateCode = date.replaceAll("-", "");
    const latestTodaySession = await tx.classSession.findFirst({
      where: { code: { startsWith: dateCode } },
      orderBy: { code: "desc" },
      select: { code: true },
    });
    const sequence = latestTodaySession
      ? Number.parseInt(latestTodaySession.code.slice(-2), 10) + 1
      : 1;
    if (!Number.isInteger(sequence) || sequence > 99) {
      throw new ServiceError("今日课次已达上限（99）", 400);
    }
    const code = `${dateCode}${String(sequence).padStart(2, "0")}`;

    const lastClassSession = await tx.classSession.findFirst({
      where: { semesterId: input.semesterId, classId },
      orderBy: { semesterNumber: "desc" },
      select: { semesterNumber: true },
    });
    const session = await tx.classSession.create({
      data: {
        code,
        semesterId: input.semesterId,
        semesterNumber: (lastClassSession?.semesterNumber ?? 0) + 1,
        date,
        classId,
        creationRequestKey: input.requestKey,
        creationRequestSnapshot: input.requestKey ? creationRequestSnapshot : null,
      },
    });

    let groupProgress: {
      status: "created" | "linked" | "independent" | "lead_required";
      group: { id: string; name: string };
      leadClass: { id: string; code: string; name: string | null } | null;
      lesson: { id: string; title: string; sequence: number } | null;
    } | null = null;
    if (classId) {
      const group = creationOptions.group;
      if (group) {
        groupProgress = { status: "independent", group: { id: group.id, name: group.name }, leadClass: group.leadClass, lesson: null };
        if (input.groupProgressIntent?.type !== "independent") {
          let lesson: { id: string; title: string; sequence: number } | null = null;
          let created = false;
          if (input.groupProgressIntent?.type === "lesson") {
            const selectedLesson = await tx.groupLesson.findUnique({
              where: { id: input.groupProgressIntent.groupLessonId },
              select: { id: true, groupId: true, title: true, sequence: true },
            });
            if (!selectedLesson || selectedLesson.groupId !== group.id) {
              throw new ServiceError("共同课不属于当前班级组", 409);
            }
            lesson = selectedLesson;
          } else if (input.groupProgressIntent?.type === "recommended") {
            const recommendation = creationOptions.recommendation;
            if (recommendation.type === "existing") {
              lesson = recommendation.lesson;
            } else if (recommendation.type === "new") {
              if (!group.isLeadClass) throw new ServiceError("只有进度基准班可以开始新的共同讲次", 409);
              const sequence = recommendation.nextSequence;
              lesson = await tx.groupLesson.create({
                data: { groupId: group.id, sequence, title: `第 ${sequence} 讲` },
                select: { id: true, title: true, sequence: true },
              });
              created = true;
              const suggestedLessonNumber = input.commonMaterialLessonNumber ?? sequence;
              const suggestedMaterial = await resolveSemesterCommonMaterial(tx, input.semesterId, suggestedLessonNumber);
              if (suggestedMaterial) {
                await tx.groupLesson.update({
                  where: { id: lesson.id },
                  data: { materialSnapshot: JSON.stringify(suggestedMaterial) },
                });
              }
            } else {
              throw new ServiceError(recommendation.reason, 409);
            }
          }
          if (lesson) {
            const duplicate = await tx.groupLessonSession.findFirst({
              where: { groupLessonId: lesson.id, session: { classId } },
              select: { id: true },
            });
            if (duplicate) throw new ServiceError("当前班级已经有真实课次关联到这一讲", 409);
            await tx.groupLessonSession.create({ data: { groupLessonId: lesson.id, sessionId: session.id, syncStatus: "synced", comparable: true } });
            groupProgress = { status: created ? "created" : "linked", group: { id: group.id, name: group.name }, leadClass: group.leadClass, lesson };
          }
        }
      }
    }

    // An explicitly independent session may still use one confirmed semester
    // script, but saving that choice is never implicit for grouped sessions.
    if (input.commonMaterialLessonNumber !== undefined && !groupProgress?.lesson) {
      const material = input.commonMaterialLessonNumber === null
        ? null
        : await resolveSemesterCommonMaterial(tx, input.semesterId, input.commonMaterialLessonNumber, session.code);
      if (input.commonMaterialLessonNumber !== null && !material) {
        throw new ServiceError(`学期公共材料库没有第 ${input.commonMaterialLessonNumber} 课`, 404);
      }
      await tx.classSession.update({
        where: { id: session.id },
        data: {
          commonMaterialSnapshot: material ? JSON.stringify(material) : null,
          commonMaterialConfirmedAt: material ? new Date() : null,
        },
      });
    }

    const enrollments = classId
      ? await tx.studentClassEnrollment.findMany({
          where: { semesterId: input.semesterId, classId, rosterStatus: "ACTIVE" },
          select: { studentId: true },
        })
      : [];
    const students = await tx.student.findMany({
      where: classId ? { id: { in: enrollments.map((item) => item.studentId) } } : undefined,
      select: { id: true },
    });
    if (students.length > 0) {
      await tx.attendance.createMany({
        data: students.map((student) => ({
          sessionId: session.id,
          studentId: student.id,
          present: true,
        })),
      });
    }

    await recalculateScoreDForStudents({
      semesterId: input.semesterId,
      classId,
      targetSessionId: session.id,
      targetDate: date,
      updateLatestInSemester: true,
    }, tx);

    return { session, studentCount: students.length, className: selectedClass?.name ?? selectedClass?.code, groupProgress, replayed: false };
  }, { timeout: 15_000 });

  if (!result.replayed) {
    void logAction({
      action: "session.created",
      targetType: "Session",
      targetId: result.session.id,
      targetName: result.session.code,
      detail: { date, class: result.className, studentCount: result.studentCount },
    });
  }

  return {
    ...result.session,
    studentCount: result.studentCount,
    groupProgress: result.groupProgress,
    idempotentReplay: result.replayed,
  };
}

/** Archives metrics, deletes a session, resequences its class, and recalculates D atomically. */
export async function deleteClassSession(input: { semesterId: string; code: string }) {
  const deleted = await prisma.$transaction(async (tx) => {
    const session = await tx.classSession.findUnique({ where: { code: input.code } });
    if (!session || session.semesterId !== input.semesterId) {
      throw new ServiceError("课次不存在或不属于该学期", 404);
    }

    const metrics = await tx.sessionMetric.findMany({
      where: { sessionId: session.id },
      select: { id: true },
    });
    for (const metric of metrics) {
      await archiveMetricBeforeUpdate(metric.id, "delete", tx);
    }

    await invalidateFeedbackPlans({
      classId: session.classId ?? undefined,
      semesterId: session.semesterId,
      sessionId: session.id,
    }, tx);

    await tx.groupLessonSession.deleteMany({ where: { sessionId: session.id } });
    await tx.classSession.delete({ where: { id: session.id } });
    await reorderSemesterNumbers(tx, input.semesterId, session.classId);
    await recalculateScoreDForStudents({
      semesterId: input.semesterId,
      classId: session.classId,
      updateLatestInSemester: true,
    }, tx);
    return session;
  }, { timeout: 15_000 });

  void logAction({
    action: "session.deleted",
    targetType: "Session",
    targetId: deleted.id,
    targetName: deleted.code,
    detail: { date: deleted.date, semesterNumber: deleted.semesterNumber },
  });
  return { success: true };
}
