import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createClassGroup, getSessionGroupProgress, setSessionGroupProgress } from "@/services/group-lesson-service";
import { createClassSession } from "@/services/session-service";

const marker = "VITEST-GROUP-PROGRESS";
let semesterId = "";
let leadClassId = "";
let followerClassId = "";
let earlyFollowerSessionId = "";

beforeAll(async () => {
  const semester = await prisma.semester.create({ data: { name: marker, startDate: "2099-08-01", endDate: "2099-12-31" } });
  semesterId = semester.id;
  const [lead, follower] = await Promise.all([
    prisma.class.create({ data: { semesterId, code: `${marker}-LEAD`, name: "合成主班" } }),
    prisma.class.create({ data: { semesterId, code: `${marker}-FOLLOW`, name: "合成从班" } }),
  ]);
  leadClassId = lead.id;
  followerClassId = follower.id;
  await createClassGroup(semesterId, { name: `${marker}-GROUP`, classIds: [leadClassId, followerClassId], leadClassId });
  await prisma.semester.update({
    where: { id: semesterId },
    data: {
      feedbackScriptLibraryName: `${marker}-LIBRARY`,
      feedbackScriptLibraryJson: JSON.stringify({ version: 1, name: `${marker}-LIBRARY`, warnings: [], entries: [{ lessonNumber: 1, topic: "合成第一讲", groupFeedback: "第一讲公共材料", perfectPrivateFeedback: "全对模板", errorPrivateFeedback: "有误模板", note: "" }] }),
      feedbackScriptLibraryUpdatedAt: new Date("2099-08-01T00:00:00.000Z"),
    },
  });
});

afterAll(async () => {
  await prisma.classGroup.deleteMany({ where: { semesterId } });
  await prisma.classSession.deleteMany({ where: { semesterId } });
  await prisma.class.deleteMany({ where: { semesterId } });
  await prisma.semester.delete({ where: { id: semesterId } });
});

describe("class group shared progress", () => {
  it("keeps an early follower session independent until the lead advances", async () => {
    const created = await createClassSession({ semesterId, classId: followerClassId, date: "2099-08-01" });
    earlyFollowerSessionId = created.id;
    expect(created.groupProgress).toMatchObject({ status: "independent", lesson: null });
  });

  it("lets the lead create a lesson and the follower catch up to it", async () => {
    const lead = await createClassSession({ semesterId, classId: leadClassId, date: "2099-08-02" });
    expect(lead.groupProgress).toMatchObject({ status: "created", lesson: { sequence: 1, title: "第 1 讲" } });
    const lesson = await prisma.groupLesson.findUniqueOrThrow({ where: { id: lead.groupProgress!.lesson!.id } });
    expect(JSON.parse(lesson.materialSnapshot)).toMatchObject({
      groupFeedbackRaw: "第一讲公共材料",
      semesterScriptSource: { lessonNumber: 1 },
    });
    const follower = await createClassSession({ semesterId, classId: followerClassId, date: "2099-08-03" });
    expect(follower.groupProgress).toMatchObject({ status: "linked", lesson: { id: lead.groupProgress?.lesson?.id, sequence: 1 } });
  });

  it("advances the lead and followers in lesson order", async () => {
    const secondLead = await createClassSession({ semesterId, classId: leadClassId, date: "2099-08-04" });
    const secondFollower = await createClassSession({ semesterId, classId: followerClassId, date: "2099-08-05" });
    expect(secondLead.groupProgress?.lesson?.sequence).toBe(2);
    expect(secondFollower.groupProgress?.lesson?.id).toBe(secondLead.groupProgress?.lesson?.id);
  });

  it("allows an independent session to be assigned explicitly without duplicating a class lesson", async () => {
    const thirdLead = await createClassSession({ semesterId, classId: leadClassId, date: "2099-08-06" });
    const lessonId = thirdLead.groupProgress?.lesson?.id;
    expect(lessonId).toBeTruthy();
    await setSessionGroupProgress({ sessionId: earlyFollowerSessionId, groupLessonId: lessonId! });
    await expect(getSessionGroupProgress(earlyFollowerSessionId)).resolves.toMatchObject({ status: "linked", lesson: { id: lessonId } });

    const other = await createClassSession({ semesterId, classId: followerClassId, date: "2099-08-07", groupProgressMode: "independent" });
    await expect(setSessionGroupProgress({ sessionId: other.id, groupLessonId: lessonId! })).rejects.toMatchObject({ status: 409 });
  });

  it("stores an explicitly selected public material on an independent session", async () => {
    const independent = await createClassSession({ semesterId, classId: followerClassId, date: "2099-08-08", groupProgressMode: "independent", commonMaterialLessonNumber: 1 });
    expect(independent.groupProgress).toMatchObject({ status: "independent", lesson: null });
    const stored = await prisma.classSession.findUniqueOrThrow({ where: { id: independent.id } });
    expect(JSON.parse(stored.commonMaterialSnapshot ?? "{}" as string)).toMatchObject({ groupFeedbackRaw: "第一讲公共材料", sessionCode: independent.code });
  });
});
