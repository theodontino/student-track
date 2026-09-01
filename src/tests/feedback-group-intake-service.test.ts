import * as XLSX from "xlsx";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const assessmentMocks = vi.hoisted(() => ({
  parseAssessmentPdf: vi.fn(),
}));

vi.mock("@/services/assessment-pdf-service", () => ({
  parseAssessmentPdf: assessmentMocks.parseAssessmentPdf,
}));

import { prisma } from "@/lib/prisma";
import { createEmptyLessonFeedbackMaterial } from "@/lib/feedback-materials";
import { createFeedbackGroupIntake } from "@/services/feedback-group-intake-service";
import type { IntakeFile } from "@/services/feedback-intake-service";
import {
  createClassGroup,
  createGroupLesson,
  linkGroupLessonSession,
} from "@/services/group-lesson-service";
import {
  STEP_CLASSROOM_HEADER,
  STEP_INTERPRETATION_PROMPT,
  STEP_PROMPT_VERSION,
} from "@/services/step-classroom-import-service";

const marker = "VITEST-GROUP-INTAKE";
const sessionCodes = [`${marker}-SESSION-01`, `${marker}-SESSION-02`];
let semesterId = "";
let groupLessonId = "";
let firstClassId = "";
let secondClassId = "";
let firstSessionId = "";
let secondSessionId = "";
let firstUniqueStudentId = "";
let secondUniqueStudentId = "";
let firstSameNameStudentId = "";
let secondSameNameStudentId = "";

function arrayBuffer(value: Uint8Array | ArrayBuffer) {
  if (value instanceof ArrayBuffer) return value;
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function intakeFile(name: string, buffer: Uint8Array | ArrayBuffer | string): IntakeFile {
  const bytes = typeof buffer === "string" ? new TextEncoder().encode(buffer) : buffer;
  return { name, buffer: arrayBuffer(bytes), source: "upload" };
}

function assistantWorkbook() {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["日期", "2099-05-01", "课次", "1"],
    ["姓名", "听课证号", "班级编号", "班级名称", "课堂纪律", "课后作业", "出门测"],
    ["合成甲", `${marker}-A`, `${marker}-01`, "合成一班", 5, 4, 5],
    ["合成乙", `${marker}-B`, `${marker}-02`, "合成二班", 4, 5, 4],
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, "课堂");
  return arrayBuffer(XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

function stepFile(classCode: string, className: string, studentId: string, studentName: string) {
  const payload = {
    class: { code: classCode, name: className },
    stepSessionId: `${marker}-${classCode}`,
    title: "合成课堂观察",
    startedAt: "2099-05-01T09:00:00+08:00",
    completedAt: "2099-05-01T10:00:00+08:00",
    questionCount: 1,
    students: [{ studentId, name: studentName, present: true, observations: [], notes: [] }],
  };
  return intakeFile(
    `${classCode}.step-classroom.txt`,
    `${STEP_CLASSROOM_HEADER}\nPROMPT_VERSION: ${STEP_PROMPT_VERSION}\n\n=== DATA BEGIN ===\n${JSON.stringify(payload)}\n=== DATA END ===\n=== PROMPT BEGIN ===\n${STEP_INTERPRETATION_PROMPT}\n=== PROMPT END ===`,
  );
}

const evidence = {
  reportTitle: "合成出门测",
  reportDate: "2099-05-01",
  totalQuestions: 5,
  correctRate: 80,
  cohortAverageRate: 70,
  knowledgePoints: [],
  wrongItems: [],
  similarPracticeCount: 0,
};

beforeAll(async () => {
  const semester = await prisma.semester.create({
    data: { name: `${marker}-SEMESTER`, startDate: "2099-01-01", endDate: "2099-12-31" },
  });
  semesterId = semester.id;
  const [firstClass, secondClass] = await Promise.all([
    prisma.class.create({ data: { semesterId, code: `${marker}-01`, name: "合成一班" } }),
    prisma.class.create({ data: { semesterId, code: `${marker}-02`, name: "合成二班" } }),
  ]);
  firstClassId = firstClass.id;
  secondClassId = secondClass.id;
  const group = await createClassGroup(semesterId, {
    name: `${marker}-GROUP`,
    classIds: [firstClassId, secondClassId],
    leadClassId: firstClassId,
  });
  const lesson = await createGroupLesson(group.id, {
    title: "合成共同课",
    sequence: 1,
    material: createEmptyLessonFeedbackMaterial(),
  });
  groupLessonId = lesson.id;
  const [firstSession, secondSession] = await Promise.all([
    prisma.classSession.create({ data: { semesterId, classId: firstClassId, code: sessionCodes[0], date: "2099-05-01", semesterNumber: 1 } }),
    prisma.classSession.create({ data: { semesterId, classId: secondClassId, code: sessionCodes[1], date: "2099-05-01", semesterNumber: 1 } }),
  ]);
  firstSessionId = firstSession.id;
  secondSessionId = secondSession.id;
  await Promise.all([
    linkGroupLessonSession(groupLessonId, { sessionId: firstSessionId, syncStatus: "synced", comparable: true }),
    linkGroupLessonSession(groupLessonId, { sessionId: secondSessionId, syncStatus: "synced", comparable: true }),
  ]);
  const [firstUnique, secondUnique, firstSameName, secondSameName] = await Promise.all([
    prisma.student.create({ data: { name: "合成甲", studentId: `${marker}-A`, gender: "女", enrollments: { create: { semesterId, classId: firstClassId } } } }),
    prisma.student.create({ data: { name: "合成乙", studentId: `${marker}-B`, gender: "男", enrollments: { create: { semesterId, classId: secondClassId } } } }),
    prisma.student.create({ data: { name: "同名学生", studentId: `${marker}-SAME-A`, gender: "女", enrollments: { create: { semesterId, classId: firstClassId } } } }),
    prisma.student.create({ data: { name: "同名学生", studentId: `${marker}-SAME-B`, gender: "男", enrollments: { create: { semesterId, classId: secondClassId } } } }),
  ]);
  firstUniqueStudentId = firstUnique.id;
  secondUniqueStudentId = secondUnique.id;
  firstSameNameStudentId = firstSameName.id;
  secondSameNameStudentId = secondSameName.id;

  // The historical lesson links remain authoritative even if current group
  // membership changes after the lessons were taught.
  await prisma.classGroupMembership.deleteMany({ where: { classId: secondClassId } });
});

beforeEach(() => {
  assessmentMocks.parseAssessmentPdf.mockReset().mockImplementation(async (_buffer: ArrayBuffer, fileName: string) => {
    if (fileName.includes("合成甲")) {
      return { reportStudentName: "合成甲", reportStudentId: `${marker}-A`, evidence };
    }
    if (fileName.includes("合成乙")) {
      return { reportStudentName: "合成乙", reportStudentId: `${marker}-B`, evidence };
    }
    if (fileName.includes("同名")) {
      return { reportStudentName: "同名学生", reportStudentId: "", evidence };
    }
    return { reportStudentName: "未归属学生", reportStudentId: `${marker}-UNKNOWN`, evidence };
  });
});

afterAll(async () => {
  await prisma.feedbackIntakeRun.deleteMany({ where: { sessionCode: { in: sessionCodes } } });
  await prisma.classGroup.deleteMany({ where: { semesterId } });
  await prisma.classSession.deleteMany({ where: { id: { in: [firstSessionId, secondSessionId] } } });
  await prisma.student.deleteMany({ where: { studentId: { startsWith: marker } } });
  await prisma.class.deleteMany({ where: { id: { in: [firstClassId, secondClassId] } } });
  await prisma.semester.deleteMany({ where: { id: semesterId } });
});

describe("feedback group intake service", () => {
  it("routes one group upload into independent runs for both historical class sessions", async () => {
    const result = await createFeedbackGroupIntake({
      groupLessonId,
      files: [
        intakeFile("两班助教表.xlsx", assistantWorkbook()),
        stepFile(`${marker}-01`, "合成一班", `${marker}-A`, "合成甲"),
        stepFile(`${marker}-02`, "合成二班", `${marker}-B`, "合成乙"),
        intakeFile("合成甲.pdf", "%PDF synthetic"),
      ],
      db: prisma,
    });

    expect(result.classes).toHaveLength(2);
    expect(result.classes.map((item) => item.classId)).toEqual([firstClassId, secondClassId]);
    expect(result.classes[0]).toMatchObject({
      studentIds: expect.arrayContaining([firstUniqueStudentId, firstSameNameStudentId]),
      studentCount: 2,
    });
    expect(result.classes[1]).toMatchObject({
      studentIds: expect.arrayContaining([secondUniqueStudentId, secondSameNameStudentId]),
      studentCount: 2,
    });
    const firstRun = result.runs.find((run) => run.sessionCode === sessionCodes[0])!;
    const secondRun = result.runs.find((run) => run.sessionCode === sessionCodes[1])!;
    expect(firstRun.sourceManifest.map((item) => item.name)).toEqual(expect.arrayContaining([
      "两班助教表.xlsx",
      `${marker}-01.step-classroom.txt`,
      "合成甲.pdf",
    ]));
    expect(secondRun.sourceManifest.map((item) => item.name)).toEqual(expect.arrayContaining([
      "两班助教表.xlsx",
      `${marker}-02.step-classroom.txt`,
    ]));
    expect(secondRun.sourceManifest.map((item) => item.name)).not.toContain("合成甲.pdf");
    expect(firstRun.appliedSummary).toMatchObject({ assessmentEvidence: { [firstUniqueStudentId]: expect.objectContaining({ studentId: firstUniqueStudentId }) } });
    expect(secondRun.appliedSummary).toMatchObject({ assessmentEvidence: {} });
    expect(result.sourceSummaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "assistant_roster", matchedClasses: 2, totalClasses: 2, status: "complete" }),
      expect.objectContaining({ kind: "step_classroom", matchedClasses: 2, totalClasses: 2, status: "complete" }),
      expect.objectContaining({ kind: "assessment_pdf", matchedStudents: 1, totalStudents: 4, status: "partial" }),
    ]));
    expect(result.unassigned).toEqual([]);
    expect(assessmentMocks.parseAssessmentPdf).toHaveBeenCalledTimes(2);
  });

  it("does not guess across duplicate names and reports PDFs outside the group roster", async () => {
    const result = await createFeedbackGroupIntake({
      groupLessonId,
      files: [
        intakeFile("同名报告.pdf", "%PDF duplicate-name"),
        intakeFile("组外报告.pdf", "%PDF outside-roster"),
      ],
      db: prisma,
    });

    expect(result.unassigned).toHaveLength(2);
    expect(result.unassigned[0]).toMatchObject({
      kind: "assessment_pdf",
      candidateStudentIds: expect.arrayContaining([firstSameNameStudentId, secondSameNameStudentId]),
      candidateClassIds: expect.arrayContaining([firstClassId, secondClassId]),
    });
    expect(result.unassigned[1]).toMatchObject({ kind: "assessment_pdf" });
    expect(result.unassigned[1]!.candidateStudentIds).toBeUndefined();
    expect(result.runs.every((run) => run.sourceManifest.length === 0)).toBe(true);
    expect(result.sourceSummaries).toContainEqual(expect.objectContaining({
      kind: "assessment_pdf",
      fileCount: 2,
      matchedStudents: 0,
      totalStudents: 4,
      issueCount: 2,
      status: "needs_review",
    }));
  });

  it("skips inbox material that clearly belongs to another class group", async () => {
    const outsideStep = stepFile("OTHER-CLASS", "其他班", "OTHER-STUDENT", "其他学生");
    const result = await createFeedbackGroupIntake({
      groupLessonId,
      files: [{ ...outsideStep, source: "inbox" }],
      db: prisma,
    });

    expect(result.unassigned).toContainEqual(expect.objectContaining({
      kind: "step_classroom",
      blocking: false,
    }));
    expect(result.sourceSummaries).toContainEqual(expect.objectContaining({
      kind: "step_classroom",
      fileCount: 0,
      status: "empty",
    }));
  });

  it("keeps cumulative source summaries when the teacher continues adding files", async () => {
    const first = await createFeedbackGroupIntake({
      groupLessonId,
      files: [
        intakeFile("累积两班助教表.xlsx", assistantWorkbook()),
        stepFile(`${marker}-01`, "合成一班", `${marker}-A`, "合成甲"),
        stepFile(`${marker}-02`, "合成二班", `${marker}-B`, "合成乙"),
      ],
      db: prisma,
    });
    const second = await createFeedbackGroupIntake({
      groupLessonId,
      files: [intakeFile("合成乙-补充.pdf", "%PDF cumulative")],
      runIds: Object.fromEntries(first.runs.map((run) => [run.sessionCode, run.id])),
      db: prisma,
    });

    expect(second.sourceSummaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "assistant_roster", fileCount: 1, matchedClasses: 2, status: "complete" }),
      expect.objectContaining({ kind: "step_classroom", fileCount: 2, matchedClasses: 2, status: "complete" }),
      expect.objectContaining({ kind: "assessment_pdf", fileCount: 1, matchedStudents: 1, status: "partial" }),
    ]));
  });

  it("does not reopen an already confirmed class when only another class receives a new file", async () => {
    const first = await createFeedbackGroupIntake({
      groupLessonId,
      files: [
        intakeFile("保留确认两班助教表.xlsx", assistantWorkbook()),
        stepFile(`${marker}-01`, "合成一班", `${marker}-A`, "合成甲"),
        stepFile(`${marker}-02`, "合成二班", `${marker}-B`, "合成乙"),
      ],
      db: prisma,
    });
    for (const item of first.classes) {
      const run = first.runs.find((candidate) => candidate.id === item.runId)!;
      await prisma.feedbackIntakeRun.update({
        where: { id: run.id },
        data: {
          status: "applied",
          appliedSummary: JSON.stringify({
            ...run.appliedSummary,
            applied: true,
            decisions: [],
            scopeConfirmation: {
              classId: item.classId,
              sessionCode: item.sessionCode,
              studentIds: item.studentIds,
              confirmedAt: "2099-05-02T00:00:00.000Z",
            },
          }),
        },
      });
    }
    const firstClassBefore = await prisma.feedbackIntakeRun.findUniqueOrThrow({ where: { id: first.classes[0]!.runId } });

    const second = await createFeedbackGroupIntake({
      groupLessonId,
      files: [
        stepFile(`${marker}-01`, "合成一班", `${marker}-A`, "合成甲"),
        intakeFile("合成乙-仅二班补充.pdf", "%PDF second-class-only"),
      ],
      runIds: Object.fromEntries(first.runs.map((run) => [run.sessionCode, run.id])),
      db: prisma,
    });
    const firstClassAfter = await prisma.feedbackIntakeRun.findUniqueOrThrow({ where: { id: first.classes[0]!.runId } });
    const secondClassAfter = second.runs.find((run) => run.id === first.classes[1]!.runId)!;

    expect(firstClassAfter).toMatchObject({
      status: "applied",
      sourceManifest: firstClassBefore.sourceManifest,
      appliedSummary: firstClassBefore.appliedSummary,
    });
    expect(firstClassAfter.updatedAt.getTime()).toBe(firstClassBefore.updatedAt.getTime());
    expect(secondClassAfter.status).not.toBe("applied");
    expect(secondClassAfter.appliedSummary.scopeConfirmation).toBeUndefined();
  });

  it("allows a direct service caller to prepare empty runs for every linked class", async () => {
    const result = await createFeedbackGroupIntake({ groupLessonId, files: [], db: prisma });
    expect(result.runs).toHaveLength(2);
    expect(result.classes.every((item) => Boolean(item.runId))).toBe(true);
    expect(result.sourceSummaries.every((summary) => summary.status === "empty")).toBe(true);
  });

  it("rejects an empty active roster before creating any group run", async () => {
    await prisma.studentClassEnrollment.updateMany({
      where: { semesterId, classId: secondClassId },
      data: { rosterStatus: "INACTIVE" },
    });
    const before = await prisma.feedbackIntakeRun.count({ where: { sessionCode: { in: sessionCodes } } });

    try {
      await expect(createFeedbackGroupIntake({
        groupLessonId,
        files: [stepFile(`${marker}-01`, "合成一班", `${marker}-A`, "合成甲")],
        db: prisma,
      })).rejects.toMatchObject({ status: 409 });
      const after = await prisma.feedbackIntakeRun.count({ where: { sessionCode: { in: sessionCodes } } });
      expect(after).toBe(before);
    } finally {
      await prisma.studentClassEnrollment.updateMany({
        where: { semesterId, classId: secondClassId },
        data: { rosterStatus: "ACTIVE" },
      });
    }
  });

  it("validates every supplied run before changing a sibling class", async () => {
    const existing = await createFeedbackGroupIntake({ groupLessonId, files: [], db: prisma });
    const firstRun = existing.runs.find((run) => run.sessionCode === sessionCodes[0])!;
    const before = await prisma.feedbackIntakeRun.findUniqueOrThrow({ where: { id: firstRun.id } });

    await expect(createFeedbackGroupIntake({
      groupLessonId,
      files: [stepFile(`${marker}-01`, "合成一班", `${marker}-A`, "合成甲")],
      runIds: { [sessionCodes[1]]: firstRun.id },
      db: prisma,
    })).rejects.toMatchObject({ status: 409 });

    const after = await prisma.feedbackIntakeRun.findUniqueOrThrow({ where: { id: firstRun.id } });
    expect(after).toMatchObject({
      sourceFingerprint: before.sourceFingerprint,
      sourceManifest: before.sourceManifest,
      appliedSummary: before.appliedSummary,
      status: before.status,
    });
  });
});
