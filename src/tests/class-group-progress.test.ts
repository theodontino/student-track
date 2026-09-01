import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  createClassGroup,
  getSessionGroupProgress,
  setSessionGroupProgress,
  updateClassGroup,
} from "@/services/group-lesson-service";
import {
  createClassSession,
  getClassSessionCreationOptions,
} from "@/services/session-service";

const marker = "VITEST-GROUP-PROGRESS-INTENT";
let semesterId = "";
let fixtureSequence = 0;

async function createGroupFixture() {
  fixtureSequence += 1;
  const suffix = String(fixtureSequence).padStart(2, "0");
  const [lead, follower] = await Promise.all([
    prisma.class.create({ data: { semesterId, code: `${marker}-${suffix}-LEAD`, name: `合成主班 ${suffix}` } }),
    prisma.class.create({ data: { semesterId, code: `${marker}-${suffix}-FOLLOW`, name: `合成从班 ${suffix}` } }),
  ]);
  const group = await createClassGroup(semesterId, {
    name: `${marker}-GROUP-${suffix}`,
    classIds: [lead.id, follower.id],
    leadClassId: lead.id,
  });
  return { lead, follower, group };
}

beforeAll(async () => {
  const semester = await prisma.semester.create({
    data: { name: marker, startDate: "2099-08-01", endDate: "2099-12-31" },
  });
  semesterId = semester.id;
  await prisma.semester.update({
    where: { id: semesterId },
    data: {
      feedbackScriptLibraryName: `${marker}-LIBRARY`,
      feedbackScriptLibraryJson: JSON.stringify({
        version: 1,
        name: `${marker}-LIBRARY`,
        warnings: [],
        entries: [{
          lessonNumber: 1,
          topic: "合成第一讲",
          groupFeedback: "第一讲公共材料",
          perfectPrivateFeedback: "全对模板",
          errorPrivateFeedback: "有误模板",
          note: "",
        }],
      }),
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

describe("class session creation intent", () => {
  it("returns an independent recommendation for a class outside a group", async () => {
    const standalone = await prisma.class.create({
      data: { semesterId, code: `${marker}-STANDALONE`, name: "合成独立班" },
    });
    await expect(getClassSessionCreationOptions({
      semesterId,
      classId: standalone.id,
      date: "2099-08-01",
    })).resolves.toMatchObject({
      class: { id: standalone.id },
      group: null,
      lessons: [],
      recommendation: { type: "independent" },
    });
    const created = await createClassSession({ semesterId, classId: standalone.id, date: "2099-08-01" });
    expect(created.groupProgress).toBeNull();
  });

  it("requires an explicit intent for grouped classes and exposes the same choice through GET", async () => {
    const { lead, group } = await createGroupFixture();
    await expect(createClassSession({
      semesterId,
      classId: lead.id,
      date: "2099-08-02",
    })).rejects.toMatchObject({ status: 400 });
    expect(await prisma.classSession.count({ where: { semesterId, classId: lead.id } })).toBe(0);

    const { GET, POST } = await import("@/app/api/semesters/[id]/session/route");
    const getRequest = new NextRequest(
      `http://localhost:3000/api/semesters/${semesterId}/session?classId=${lead.id}&date=2099-08-02`,
    );
    const optionsResponse = await GET(getRequest, { params: Promise.resolve({ id: semesterId }) });
    expect(optionsResponse.status).toBe(200);
    await expect(optionsResponse.json()).resolves.toMatchObject({
      group: { id: group.id, isLeadClass: true },
      recommendation: { type: "new", nextSequence: 1 },
    });

    const postRequest = new NextRequest(`http://localhost:3000/api/semesters/${semesterId}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classId: lead.id, date: "2099-08-02", requestKey: `${marker}-missing-intent-${fixtureSequence}` }),
    });
    const postResponse = await POST(postRequest, { params: Promise.resolve({ id: semesterId }) });
    expect(postResponse.status).toBe(400);
    await expect(postResponse.json()).resolves.toMatchObject({ error: expect.stringContaining("必须明确选择") });
  });

  it("lets only the lead apply a new recommendation and preserves the public material suggestion", async () => {
    const { lead: leadClass, follower } = await createGroupFixture();
    const followerOptions = await getClassSessionCreationOptions({ semesterId, classId: follower.id, date: "2099-08-03" });
    expect(followerOptions.recommendation).toMatchObject({ type: "waiting" });
    await expect(createClassSession({
      semesterId,
      classId: follower.id,
      date: "2099-08-03",
      groupProgressIntent: { type: "recommended" },
    })).rejects.toMatchObject({ status: 409 });
    expect(await prisma.classSession.count({ where: { classId: follower.id } })).toBe(0);

    const lead = await createClassSession({
      semesterId,
      classId: leadClass.id,
      date: "2099-08-03",
      groupProgressIntent: { type: "recommended" },
    });
    expect(lead.groupProgress).toMatchObject({ status: "created", lesson: { sequence: 1, title: "第 1 讲" } });
    const lesson = await prisma.groupLesson.findUniqueOrThrow({ where: { id: lead.groupProgress!.lesson!.id } });
    expect(JSON.parse(lesson.materialSnapshot)).toMatchObject({
      groupFeedbackRaw: "第一讲公共材料",
      semesterScriptSource: { lessonNumber: 1 },
    });
  });

  it("replays a recommended lead request without advancing to another shared lesson", async () => {
    const { lead, group } = await createGroupFixture();
    const requestKey = `${marker}-recommended-retry-${fixtureSequence}`;
    const input = {
      semesterId,
      classId: lead.id,
      date: "2099-08-31",
      requestKey,
      groupProgressIntent: { type: "recommended" as const },
    };

    const first = await createClassSession(input);
    const replay = await createClassSession(input);

    expect(replay).toMatchObject({ id: first.id, code: first.code, idempotentReplay: true });
    expect(await prisma.classSession.count({ where: { creationRequestKey: requestKey } })).toBe(1);
    expect(await prisma.groupLesson.count({ where: { groupId: group.id } })).toBe(1);
  });

  it("requires a newly added class to choose its starting lesson explicitly", async () => {
    const { lead, follower, group } = await createGroupFixture();
    const leadSession = await createClassSession({
      semesterId,
      classId: lead.id,
      date: "2099-08-04",
      groupProgressIntent: { type: "recommended" },
    });
    const newcomer = await prisma.class.create({
      data: { semesterId, code: `${marker}-NEW-${fixtureSequence}`, name: "合成新加入班" },
    });
    await updateClassGroup(group.id, {
      name: group.name,
      classIds: [lead.id, follower.id, newcomer.id],
      leadClassId: lead.id,
    });

    const options = await getClassSessionCreationOptions({ semesterId, classId: newcomer.id, date: "2099-08-05" });
    expect(options.recommendation).toMatchObject({ type: "choice_required" });
    expect(options.lessons).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: leadSession.groupProgress?.lesson?.id, sequence: 1, started: true }),
    ]));

    const joined = await createClassSession({
      semesterId,
      classId: newcomer.id,
      date: "2099-08-05",
      groupProgressIntent: { type: "lesson", groupLessonId: leadSession.groupProgress!.lesson!.id },
    });
    expect(joined.groupProgress).toMatchObject({ status: "linked", lesson: { sequence: 1 } });
  });

  it("moves forward from the class highest linked lesson instead of filling earlier gaps", async () => {
    const { lead, follower } = await createGroupFixture();
    const leadSessions = [];
    for (const date of ["2099-08-06", "2099-08-07", "2099-08-08"]) {
      leadSessions.push(await createClassSession({
        semesterId,
        classId: lead.id,
        date,
        groupProgressIntent: { type: "recommended" },
      }));
    }
    const secondLessonId = leadSessions[1].groupProgress!.lesson!.id;
    const thirdLessonId = leadSessions[2].groupProgress!.lesson!.id;
    await createClassSession({
      semesterId,
      classId: follower.id,
      date: "2099-08-09",
      groupProgressIntent: { type: "lesson", groupLessonId: secondLessonId },
    });

    const options = await getClassSessionCreationOptions({ semesterId, classId: follower.id, date: "2099-08-10" });
    expect(options.lessons).toEqual(expect.arrayContaining([
      expect.objectContaining({ sequence: 1 }),
      expect.objectContaining({ sequence: 3 }),
    ]));
    expect(options.recommendation).toMatchObject({
      type: "existing",
      lesson: { id: thirdLessonId, sequence: 3 },
    });
  });

  it("does not silently re-fill a lesson after its session is made independent", async () => {
    const { lead, follower } = await createGroupFixture();
    const firstLead = await createClassSession({
      semesterId,
      classId: lead.id,
      date: "2099-08-11",
      groupProgressIntent: { type: "recommended" },
    });
    const firstFollower = await createClassSession({
      semesterId,
      classId: follower.id,
      date: "2099-08-12",
      groupProgressIntent: { type: "lesson", groupLessonId: firstLead.groupProgress!.lesson!.id },
    });
    const secondLead = await createClassSession({
      semesterId,
      classId: lead.id,
      date: "2099-08-13",
      groupProgressIntent: { type: "recommended" },
    });
    const secondFollower = await createClassSession({
      semesterId,
      classId: follower.id,
      date: "2099-08-14",
      groupProgressIntent: { type: "recommended" },
    });
    expect(secondFollower.groupProgress?.lesson?.id).toBe(secondLead.groupProgress?.lesson?.id);

    await setSessionGroupProgress({ sessionId: secondFollower.id, groupLessonId: null });
    await expect(getSessionGroupProgress(secondFollower.id)).resolves.toMatchObject({ status: "independent", lesson: null });
    const options = await getClassSessionCreationOptions({ semesterId, classId: follower.id, date: "2099-08-15" });
    expect(options.recommendation).toMatchObject({ type: "choice_required" });
    await expect(createClassSession({
      semesterId,
      classId: follower.id,
      date: "2099-08-15",
      groupProgressIntent: { type: "recommended" },
    })).rejects.toMatchObject({ status: 409 });
    expect(await prisma.classSession.count({ where: { id: firstFollower.id } })).toBe(1);
  });

  it("requires an explicit choice when backfilling an older date", async () => {
    const { lead } = await createGroupFixture();
    await createClassSession({
      semesterId,
      classId: lead.id,
      date: "2099-08-20",
      groupProgressIntent: { type: "recommended" },
    });
    const options = await getClassSessionCreationOptions({ semesterId, classId: lead.id, date: "2099-08-19" });
    expect(options.recommendation).toMatchObject({ type: "choice_required" });
  });

  it("keeps recommending a historically started next lesson after changing the lead class", async () => {
    const { lead, follower, group } = await createGroupFixture();
    const firstLead = await createClassSession({
      semesterId,
      classId: lead.id,
      date: "2099-08-21",
      groupProgressIntent: { type: "recommended" },
    });
    await createClassSession({
      semesterId,
      classId: follower.id,
      date: "2099-08-22",
      groupProgressIntent: { type: "lesson", groupLessonId: firstLead.groupProgress!.lesson!.id },
    });
    const secondLead = await createClassSession({
      semesterId,
      classId: lead.id,
      date: "2099-08-23",
      groupProgressIntent: { type: "recommended" },
    });
    const newLead = await prisma.class.create({
      data: { semesterId, code: `${marker}-NEW-LEAD-${fixtureSequence}`, name: "合成新基准班" },
    });
    await updateClassGroup(group.id, {
      name: group.name,
      classIds: [lead.id, follower.id, newLead.id],
      leadClassId: newLead.id,
    });

    const options = await getClassSessionCreationOptions({ semesterId, classId: follower.id, date: "2099-08-24" });
    expect(options.lessons).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: secondLead.groupProgress!.lesson!.id, started: true }),
    ]));
    expect(options.recommendation).toMatchObject({
      type: "existing",
      lesson: { id: secondLead.groupProgress!.lesson!.id, sequence: 2 },
    });
  });

  it("rejects a duplicate explicit class-to-lesson link inside the creation transaction", async () => {
    const { lead, follower } = await createGroupFixture();
    const leadSession = await createClassSession({
      semesterId,
      classId: lead.id,
      date: "2099-08-27",
      groupProgressIntent: { type: "recommended" },
    });
    const lessonId = leadSession.groupProgress!.lesson!.id;
    await createClassSession({
      semesterId,
      classId: follower.id,
      date: "2099-08-28",
      groupProgressIntent: { type: "lesson", groupLessonId: lessonId },
    });
    await expect(createClassSession({
      semesterId,
      classId: follower.id,
      date: "2099-08-29",
      groupProgressIntent: { type: "lesson", groupLessonId: lessonId },
    })).rejects.toMatchObject({ status: 409 });
    expect(await prisma.classSession.count({ where: { classId: follower.id } })).toBe(1);
  });

  it("stores an explicitly selected public material on an independent grouped session", async () => {
    const { follower } = await createGroupFixture();
    const independent = await createClassSession({
      semesterId,
      classId: follower.id,
      date: "2099-08-30",
      groupProgressIntent: { type: "independent" },
      commonMaterialLessonNumber: 1,
    });
    expect(independent.groupProgress).toMatchObject({ status: "independent", lesson: null });
    const stored = await prisma.classSession.findUniqueOrThrow({ where: { id: independent.id } });
    expect(JSON.parse(stored.commonMaterialSnapshot ?? "{}")).toMatchObject({
      groupFeedbackRaw: "第一讲公共材料",
      sessionCode: independent.code,
    });
  });
});
