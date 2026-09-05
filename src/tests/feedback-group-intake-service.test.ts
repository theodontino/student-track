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
import {
  createFeedbackGroupIntake,
  prepareFeedbackGroupIntakeFromExistingFacts,
} from "@/services/feedback-group-intake-service";
import {
  createOrGetFeedbackIntakeRun,
  resolveFeedbackIntakeRun,
  type IntakeFile,
} from "@/services/feedback-intake-service";
import {
  createClassGroup,
  createGroupLesson,
  getSessionGroupProgress,
  linkGroupLessonSession,
} from "@/services/group-lesson-service";
import { createFeedbackPlan } from "@/services/feedback-plan-service";
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
    ["合成甲", `${marker}-A`, `${marker}-01`, "合成一班", 5, 4, 4],
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

beforeEach(async () => {
  await prisma.feedbackIntakeRun.deleteMany({ where: { sessionCode: { in: sessionCodes } } });
  await prisma.sessionMetric.deleteMany({ where: { sessionId: { in: [firstSessionId, secondSessionId] } } });
  assessmentMocks.parseAssessmentPdf.mockReset().mockImplementation(async (buffer: ArrayBuffer, fileName: string) => {
    const sourceText = new TextDecoder().decode(buffer);
    const fileEvidence = {
      ...evidence,
      ...(fileName.includes("81") || sourceText.includes("rate-81") ? { correctRate: 81 } : {}),
      ...(fileName.includes("82") || sourceText.includes("rate-82") ? { correctRate: 82 } : {}),
      ...(fileName.includes("83") || sourceText.includes("rate-83") ? { correctRate: 83 } : {}),
      ...(fileName.includes("no-date") ? { reportDate: "" } : {}),
      ...(fileName.includes("wrong-date") ? { reportDate: "2099-05-02" } : {}),
    };
    if (fileName.includes("合成甲")) {
      return { reportStudentName: "合成甲", reportStudentId: `${marker}-A`, evidence: fileEvidence };
    }
    if (fileName.includes("合成乙")) {
      return { reportStudentName: "合成乙", reportStudentId: `${marker}-B`, evidence: fileEvidence };
    }
    if (sourceText.includes("same-name-a")) {
      return { reportStudentName: "同名学生", reportStudentId: `${marker}-SAME-A`, evidence: fileEvidence };
    }
    if (sourceText.includes("same-name-c")) {
      return { reportStudentName: "同名学生", reportStudentId: `${marker}-SAME-C`, evidence: fileEvidence };
    }
    if (fileName.includes("同名")) {
      return { reportStudentName: "同名学生", reportStudentId: "", evidence };
    }
    return { reportStudentName: "未归属学生", reportStudentId: `${marker}-UNKNOWN`, evidence: fileEvidence };
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
  it("lets the teacher adopt a conflicting decimal PDF A while preserving existing B/C", async () => {
    await prisma.sessionMetric.upsert({
      where: { studentId_sessionId: { studentId: firstUniqueStudentId, sessionId: firstSessionId } },
      create: {
        studentId: firstUniqueStudentId,
        sessionId: firstSessionId,
        date: "2099-05-01",
        scoreA: 2,
        scoreB: 4,
        scoreC: 2,
        scoreD: 3,
        operator: "system",
      },
      update: {
        scoreA: 2,
        scoreB: 4,
        scoreC: 2,
        operator: "system",
      },
    });
    const result = await createFeedbackGroupIntake({
      groupLessonId,
      sessionCodes: [sessionCodes[0]],
      files: [intakeFile("合成甲-83.pdf", "%PDF decimal-score")],
      db: prisma,
    });
    const run = result.runs[0]!;
    const conflict = run.issues.find((item) => item.code === "score_conflict");
    expect(conflict?.scoreConflict).toMatchObject({
      studentId: `${marker}-A`,
      dimension: "A",
      candidates: expect.arrayContaining([
        expect.objectContaining({ sourceKind: "current_metric", score: 2 }),
        expect.objectContaining({ sourceKind: "assessment_pdf", score: 4.2 }),
      ]),
    });
    await expect(resolveFeedbackIntakeRun(run.id, { action: "confirm", decisions: [] }, prisma))
      .rejects.toThrow("材料异常未处理");
    await expect(resolveFeedbackIntakeRun(run.id, {
      action: "confirm",
      decisions: [{ issueId: conflict!.id, action: "use_score_candidate", candidateId: "missing-candidate" }],
    }, prisma)).rejects.toThrow("材料异常未处理");
    const pdfCandidate = conflict!.scoreConflict!.candidates.find((candidate) => candidate.sourceKind === "assessment_pdf")!;

    await resolveFeedbackIntakeRun(run.id, {
      action: "confirm",
      decisions: [{ issueId: conflict!.id, action: "use_score_candidate", candidateId: pdfCandidate.id }],
    }, prisma);
    await expect(prisma.sessionMetric.findUnique({
      where: { studentId_sessionId: { studentId: firstUniqueStudentId, sessionId: firstSessionId } },
    })).resolves.toMatchObject({ scoreA: 4.2, scoreB: 4, scoreC: 2 });
  });

  it("shows a score conflict during inspection even when the PDF date needs acceptance", async () => {
    await prisma.sessionMetric.create({
      data: {
        studentId: firstUniqueStudentId,
        sessionId: firstSessionId,
        date: "2099-05-01",
        scoreA: 2,
        scoreB: 4,
        scoreC: 2,
        scoreD: 3,
        operator: "teacher",
      },
    });
    const result = await createFeedbackGroupIntake({
      groupLessonId,
      sessionCodes: [sessionCodes[0]],
      files: [intakeFile("合成甲-83-wrong-date.pdf", "%PDF wrong-date")],
      db: prisma,
    });
    const run = result.runs[0]!;
    const dateIssue = run.issues.find((item) => item.code === "assessment_date_mismatch")!;
    const conflict = run.issues.find((item) => item.code === "score_conflict")!;
    expect(dateIssue).toBeTruthy();
    expect(conflict.scoreConflict?.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceKind: "current_metric", score: 2 }),
      expect.objectContaining({ sourceKind: "assessment_pdf", score: 4.2 }),
    ]));

    const acceptDate = { issueId: dateIssue.id, action: "accept_source" as const, sourceName: dateIssue.sourceName };
    await expect(resolveFeedbackIntakeRun(run.id, {
      action: "confirm",
      decisions: [acceptDate],
    }, prisma)).resolves.toMatchObject({
      status: "needs_review",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "score_conflict" }),
      ]),
    });

    const pdfCandidate = conflict.scoreConflict!.candidates.find((candidate) => candidate.sourceKind === "assessment_pdf")!;
    const confirmed = await resolveFeedbackIntakeRun(run.id, {
      action: "confirm",
      decisions: [
        acceptDate,
        { issueId: conflict.id, action: "use_score_candidate", candidateId: pdfCandidate.id },
      ],
    }, prisma);
    expect(confirmed).toMatchObject({ status: "applied" });
    expect(confirmed.appliedSummary.assessmentEvidence).toMatchObject({
      [firstUniqueStudentId]: { correctRate: 83 },
    });
    await expect(prisma.sessionMetric.findUnique({
      where: { studentId_sessionId: { studentId: firstUniqueStudentId, sessionId: firstSessionId } },
    })).resolves.toMatchObject({ scoreA: 4.2, scoreB: 4, scoreC: 2 });
  });

  it("clears a dynamically discovered score conflict when an accepted source is changed to ignore", async () => {
    await prisma.sessionMetric.create({
      data: {
        studentId: firstUniqueStudentId,
        sessionId: firstSessionId,
        date: "2099-05-01",
        scoreA: 2,
        scoreB: 4,
        scoreC: 2,
        scoreD: 3,
        operator: "teacher",
      },
    });
    const result = await createFeedbackGroupIntake({
      groupLessonId,
      sessionCodes: [sessionCodes[0]],
      files: [intakeFile("合成甲-83-wrong-date.pdf", "%PDF legacy-boundary-preview")],
      db: prisma,
    });
    const run = result.runs[0]!;
    const dateIssue = run.issues.find((item) => item.code === "assessment_date_mismatch")!;
    await prisma.feedbackIntakeRun.update({
      where: { id: run.id },
      data: { issues: JSON.stringify([dateIssue]) },
    });

    const reviewed = await resolveFeedbackIntakeRun(run.id, {
      action: "confirm",
      decisions: [{ issueId: dateIssue.id, action: "accept_source", sourceName: dateIssue.sourceName }],
    }, prisma);
    expect(reviewed.status).toBe("needs_review");
    expect(reviewed.issues).toContainEqual(expect.objectContaining({ code: "score_conflict" }));

    const confirmed = await resolveFeedbackIntakeRun(run.id, {
      action: "confirm",
      decisions: [{ issueId: dateIssue.id, action: "ignore_source", sourceName: dateIssue.sourceName }],
    }, prisma);
    expect(confirmed.status).toBe("applied");
    expect(confirmed.issues).not.toContainEqual(expect.objectContaining({ code: "score_conflict" }));
    expect(confirmed.appliedSummary.assessmentEvidence).toEqual({});
    await expect(prisma.sessionMetric.findUnique({
      where: { studentId_sessionId: { studentId: firstUniqueStudentId, sessionId: firstSessionId } },
    })).resolves.toMatchObject({ scoreA: 2, scoreB: 4, scoreC: 2 });
  });

  it("can skip writing a conflicting A without discarding PDF evidence", async () => {
    await prisma.sessionMetric.upsert({
      where: { studentId_sessionId: { studentId: firstUniqueStudentId, sessionId: firstSessionId } },
      create: {
        studentId: firstUniqueStudentId,
        sessionId: firstSessionId,
        date: "2099-05-01",
        scoreA: 4.8,
        scoreB: 4,
        scoreC: 2,
        scoreD: 3,
        operator: "teacher",
      },
      update: {
        scoreA: 4.8,
        scoreB: 4,
        scoreC: 2,
        operator: "teacher",
      },
    });
    const result = await createFeedbackGroupIntake({
      groupLessonId,
      sessionCodes: [sessionCodes[0]],
      files: [intakeFile("合成甲-83.pdf", "%PDF lower-authority-score")],
      db: prisma,
    });
    const run = result.runs[0]!;
    const conflict = run.issues.find((item) => item.code === "score_conflict")!;
    expect(conflict.scoreConflict?.candidates).toContainEqual(expect.objectContaining({ sourceKind: "current_metric", score: 4.8 }));
    const confirmed = await resolveFeedbackIntakeRun(run.id, {
      action: "confirm",
      decisions: [{ issueId: conflict.id, action: "skip_score" }],
    }, prisma);
    await expect(prisma.sessionMetric.findUnique({
      where: { studentId_sessionId: { studentId: firstUniqueStudentId, sessionId: firstSessionId } },
    })).resolves.toMatchObject({ scoreA: 4.8, scoreB: 4, scoreC: 2, operator: "teacher" });
    expect(confirmed.appliedSummary.assessmentEvidence).toHaveProperty(firstUniqueStudentId);
  });

  it("keeps a uniquely matched automatic score when the PDF report date is missing", async () => {
    const result = await createFeedbackGroupIntake({
      groupLessonId,
      sessionCodes: [sessionCodes[0]],
      files: [intakeFile("合成甲-no-date.pdf", "%PDF missing-date")],
      db: prisma,
    });
    const run = result.runs[0]!;
    expect(run.issues).toContainEqual(expect.objectContaining({ code: "assessment_date_missing" }));
    const parsedResult = run.appliedSummary.parsedResult as { students?: Array<{ studentId?: string; scores?: Record<string, number | null> }> } | undefined;
    expect(parsedResult?.students?.find((student) => student.studentId === `${marker}-A`)?.scores?.A).toBe(4);
  });

  it("creates a PDF-only metric with neutral B/C defaults", async () => {
    const result = await createFeedbackGroupIntake({
      groupLessonId,
      sessionCodes: [sessionCodes[0]],
      files: [intakeFile("合成甲-83.pdf", "%PDF pdf-only")],
      db: prisma,
    });
    const run = result.runs[0]!;
    await expect(resolveFeedbackIntakeRun(run.id, { action: "confirm", decisions: [] }, prisma))
      .resolves.toMatchObject({ status: "applied" });
    await expect(prisma.sessionMetric.findUnique({
      where: { studentId_sessionId: { studentId: firstUniqueStudentId, sessionId: firstSessionId } },
    })).resolves.toMatchObject({ scoreA: 4.2, scoreB: 3, scoreC: 3 });
  });

  it("does not create a conflict when the current and PDF A values are equal", async () => {
    await prisma.sessionMetric.create({
      data: {
        studentId: firstUniqueStudentId,
        sessionId: firstSessionId,
        date: "2099-05-01",
        scoreA: 4,
        scoreB: 5,
        scoreC: 2,
        scoreD: 3,
        operator: "teacher",
      },
    });
    const result = await createFeedbackGroupIntake({
      groupLessonId,
      sessionCodes: [sessionCodes[0]],
      files: [intakeFile("合成甲-80.pdf", "%PDF same-score")],
      db: prisma,
    });
    const run = result.runs[0]!;
    expect(run.issues).not.toContainEqual(expect.objectContaining({ code: "score_conflict" }));
    await expect(resolveFeedbackIntakeRun(run.id, { action: "confirm", decisions: [] }, prisma))
      .resolves.toMatchObject({ status: "applied" });
    await expect(prisma.sessionMetric.findUnique({
      where: { studentId_sessionId: { studentId: firstUniqueStudentId, sessionId: firstSessionId } },
    })).resolves.toMatchObject({ scoreA: 4, scoreB: 5, scoreC: 2 });
  });

  it("rejects a saved score choice when the current metric changed during review", async () => {
    await prisma.sessionMetric.create({
      data: {
        studentId: firstUniqueStudentId,
        sessionId: firstSessionId,
        date: "2099-05-01",
        scoreA: 2,
        scoreB: 4,
        scoreC: 2,
        scoreD: 3,
        operator: "teacher",
      },
    });
    const result = await createFeedbackGroupIntake({
      groupLessonId,
      sessionCodes: [sessionCodes[0]],
      files: [intakeFile("合成甲-83.pdf", "%PDF stale-score")],
      db: prisma,
    });
    const run = result.runs[0]!;
    const conflict = run.issues.find((item) => item.code === "score_conflict")!;
    const pdfCandidate = conflict.scoreConflict!.candidates.find((candidate) => candidate.sourceKind === "assessment_pdf")!;
    await prisma.sessionMetric.update({
      where: { studentId_sessionId: { studentId: firstUniqueStudentId, sessionId: firstSessionId } },
      data: { scoreA: 4.8 },
    });

    await expect(resolveFeedbackIntakeRun(run.id, {
      action: "confirm",
      decisions: [{ issueId: conflict.id, action: "use_score_candidate", candidateId: pdfCandidate.id }],
    }, prisma)).rejects.toThrow("核对期间已变化");
    await expect(prisma.sessionMetric.findUnique({
      where: { studentId_sessionId: { studentId: firstUniqueStudentId, sessionId: firstSessionId } },
    })).resolves.toMatchObject({ scoreA: 4.8, scoreB: 4, scoreC: 2, scoreD: 3 });
  });

  it("routes differing assistant and PDF A values to one structured conflict", async () => {
    const result = await createFeedbackGroupIntake({
      groupLessonId,
      sessionCodes: [sessionCodes[0]],
      files: [
        intakeFile("冲突助教表.xlsx", assistantWorkbook()),
        intakeFile("合成甲-83-冲突.pdf", "%PDF conflicting-score"),
      ],
      db: prisma,
    });
    const run = result.runs[0]!;
    const conflict = run.issues.find((item) => item.code === "score_conflict")!;
    expect(conflict.scoreConflict).toMatchObject({
      studentId: `${marker}-A`,
      dimension: "A",
      candidates: expect.arrayContaining([
        expect.objectContaining({ sourceKind: "assistant_roster", score: 4 }),
        expect.objectContaining({ sourceKind: "assessment_pdf", score: 4.2 }),
      ]),
    });
    expect(conflict.scoreConflict!.candidates.some((candidate) => candidate.sourceKind === "current_metric")).toBe(false);
    const parsedResult = run.appliedSummary.parsedResult as { students?: Array<{ studentId?: string; scores?: Record<string, number | null> }> } | undefined;
    expect(parsedResult?.students?.find((student) => student.studentId === `${marker}-A`)?.scores).toEqual({
      A: null,
      B: 5,
      C: 4,
    });
    await expect(resolveFeedbackIntakeRun(run.id, {
      action: "confirm",
      decisions: [{ issueId: conflict.id, action: "skip_score" }],
    }, prisma)).rejects.toThrow("材料异常未处理");
    await expect(prisma.sessionMetric.findUnique({
      where: { studentId_sessionId: { studentId: firstUniqueStudentId, sessionId: firstSessionId } },
    })).resolves.toBeNull();
    const assistantCandidate = conflict.scoreConflict!.candidates.find((candidate) => candidate.sourceKind === "assistant_roster")!;
    await expect(resolveFeedbackIntakeRun(run.id, {
      action: "confirm",
      decisions: [{ issueId: conflict.id, action: "use_score_candidate", candidateId: assistantCandidate.id }],
    }, prisma))
      .resolves.toMatchObject({ status: "applied" });
  });

  it("keeps same-named students' score conflicts independently addressable", async () => {
    const peer = await prisma.student.create({
      data: {
        name: "同名学生",
        studentId: `${marker}-SAME-C`,
        gender: "男",
        enrollments: { create: { semesterId, classId: firstClassId } },
      },
    });
    try {
      await prisma.sessionMetric.createMany({
        data: [firstSameNameStudentId, peer.id].map((studentId) => ({
          studentId,
          sessionId: firstSessionId,
          date: "2099-05-01",
          scoreA: 2,
          scoreB: 3,
          scoreC: 3,
          scoreD: 3,
          operator: "teacher",
        })),
      });
      const created = await createOrGetFeedbackIntakeRun({
        sessionCode: sessionCodes[0],
        files: [
          intakeFile("同名评分-83.pdf", "%PDF same-name-a"),
          intakeFile("同名评分-83.pdf", "%PDF same-name-c"),
        ],
        db: prisma,
      });
      const conflicts = created.run.issues.filter((item) => item.code === "score_conflict");
      expect(conflicts).toHaveLength(2);
      expect(new Set(conflicts.map((item) => item.id)).size).toBe(2);
      expect(new Set(conflicts.map((item) => item.scoreConflict?.studentId))).toEqual(new Set([
        `${marker}-SAME-A`,
        `${marker}-SAME-C`,
      ]));

      const decisions = conflicts.map((conflict) => {
        const sourceKind = conflict.scoreConflict!.studentId === `${marker}-SAME-A`
          ? "assessment_pdf"
          : "current_metric";
        const selected = conflict.scoreConflict!.candidates.find((candidate) => candidate.sourceKind === sourceKind)!;
        return { issueId: conflict.id, action: "use_score_candidate" as const, candidateId: selected.id };
      });
      await expect(resolveFeedbackIntakeRun(created.run.id, {
        action: "confirm",
        decisions,
      }, prisma)).resolves.toMatchObject({ status: "applied" });
      await expect(prisma.sessionMetric.findUnique({
        where: { studentId_sessionId: { studentId: firstSameNameStudentId, sessionId: firstSessionId } },
      })).resolves.toMatchObject({ scoreA: 4.2 });
      await expect(prisma.sessionMetric.findUnique({
        where: { studentId_sessionId: { studentId: peer.id, sessionId: firstSessionId } },
      })).resolves.toMatchObject({ scoreA: 2 });
    } finally {
      await prisma.student.delete({ where: { id: peer.id } });
    }
  });

  it("requires a choice when two PDF files produce different A values", async () => {
    const result = await createFeedbackGroupIntake({
      groupLessonId,
      sessionCodes: [sessionCodes[0]],
      files: [
        intakeFile("合成甲-80.pdf", "%PDF first-assessment"),
        intakeFile("合成甲-83.pdf", "%PDF second-assessment"),
      ],
      db: prisma,
    });
    const run = result.runs[0]!;
    const duplicate = run.issues.find((item) => item.code === "assessment_duplicate")!;
    const conflict = run.issues.find((item) => item.code === "score_conflict")!;
    expect(duplicate.assessmentDuplicate?.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceName: "合成甲-80.pdf", scoreA: 4 }),
      expect.objectContaining({ sourceName: "合成甲-83.pdf", scoreA: 4.2 }),
    ]));
    expect(conflict.scoreConflict?.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceName: "合成甲-80.pdf", score: 4 }),
      expect.objectContaining({ sourceName: "合成甲-83.pdf", score: 4.2 }),
    ]));
    const parsedResult = run.appliedSummary.parsedResult as { students?: Array<{ studentId?: string; scores?: Record<string, number | null> }> } | undefined;
    expect(parsedResult?.students?.find((student) => student.studentId === `${marker}-A`)?.scores?.A).toBeNull();
    const firstPdf = conflict.scoreConflict!.candidates.find((candidate) => candidate.sourceName === "合成甲-80.pdf")!;
    const secondPdf = conflict.scoreConflict!.candidates.find((candidate) => candidate.sourceName === "合成甲-83.pdf")!;
    const firstEvidence = duplicate.assessmentDuplicate!.candidates.find((candidate) => candidate.sourceName === "合成甲-80.pdf")!;
    await expect(resolveFeedbackIntakeRun(run.id, {
      action: "confirm",
      decisions: [
        { issueId: duplicate.id, action: "select_pdf", studentId: duplicate.assessmentDuplicate!.studentId, sourceName: firstEvidence.sourceName, candidateId: firstEvidence.id },
        { issueId: conflict.id, action: "use_score_candidate", candidateId: secondPdf.id },
      ],
    }, prisma)).rejects.toThrow("材料异常未处理");
    const confirmed = await resolveFeedbackIntakeRun(run.id, {
      action: "confirm",
      decisions: [
        { issueId: duplicate.id, action: "select_pdf", studentId: duplicate.assessmentDuplicate!.studentId, sourceName: firstEvidence.sourceName, candidateId: firstEvidence.id },
        { issueId: conflict.id, action: "use_score_candidate", candidateId: firstPdf.id },
      ],
    }, prisma);
    expect(confirmed.appliedSummary.assessmentEvidence).toMatchObject({
      [firstUniqueStudentId]: { correctRate: 80 },
    });
  });

  it("requires one PDF choice when distinct correct rates round to the same A", async () => {
    const result = await createFeedbackGroupIntake({
      groupLessonId,
      sessionCodes: [sessionCodes[0]],
      files: [
        intakeFile("合成甲-81.pdf", "%PDF assessment-81"),
        intakeFile("合成甲-82.pdf", "%PDF assessment-82"),
      ],
      db: prisma,
    });
    const run = result.runs[0]!;
    const duplicate = run.issues.find((item) => item.code === "assessment_duplicate")!;
    expect(duplicate.assessmentDuplicate).toMatchObject({
      studentId: firstUniqueStudentId,
      studentName: "合成甲",
      candidates: expect.arrayContaining([
        expect.objectContaining({ sourceName: "合成甲-81.pdf", correctRate: 81, scoreA: 4.1 }),
        expect.objectContaining({ sourceName: "合成甲-82.pdf", correctRate: 82, scoreA: 4.1 }),
      ]),
    });
    expect(run.issues).not.toContainEqual(expect.objectContaining({ code: "score_conflict" }));
    expect(run.appliedSummary.assessmentEvidence).not.toHaveProperty(firstUniqueStudentId);
    await expect(resolveFeedbackIntakeRun(run.id, { action: "confirm", decisions: [] }, prisma))
      .rejects.toThrow("材料异常未处理");

    const selected = duplicate.assessmentDuplicate!.candidates.find((candidate) => candidate.correctRate === 82)!;
    await expect(resolveFeedbackIntakeRun(run.id, {
      action: "confirm",
      decisions: [{ issueId: duplicate.id, action: "ignore_source", sourceName: selected.sourceName }],
    }, prisma)).rejects.toThrow("材料异常未处理");
    await expect(resolveFeedbackIntakeRun(run.id, {
      action: "confirm",
      decisions: [{
        issueId: duplicate.id,
        action: "select_pdf",
        studentId: "another-student",
        sourceName: selected.sourceName,
        candidateId: selected.id,
      }],
    }, prisma)).rejects.toThrow("材料异常未处理");
    await expect(resolveFeedbackIntakeRun(run.id, {
      action: "confirm",
      decisions: [{
        issueId: duplicate.id,
        action: "select_pdf",
        studentId: duplicate.assessmentDuplicate!.studentId,
        sourceName: selected.sourceName,
        candidateId: "missing-candidate",
      }],
    }, prisma)).rejects.toThrow("材料异常未处理");
    await expect(prisma.sessionMetric.findUnique({
      where: { studentId_sessionId: { studentId: firstUniqueStudentId, sessionId: firstSessionId } },
    })).resolves.toBeNull();
    const confirmed = await resolveFeedbackIntakeRun(run.id, {
      action: "confirm",
      decisions: [{
        issueId: duplicate.id,
        action: "select_pdf",
        studentId: duplicate.assessmentDuplicate!.studentId,
        sourceName: selected.sourceName,
        candidateId: selected.id,
      }],
    }, prisma);
    expect(confirmed.appliedSummary.assessmentEvidence).toMatchObject({
      [firstUniqueStudentId]: { correctRate: 82 },
    });
    await expect(prisma.sessionMetric.findUnique({
      where: { studentId_sessionId: { studentId: firstUniqueStudentId, sessionId: firstSessionId } },
    })).resolves.toMatchObject({ scoreA: 4.1 });
  });

  it("persists score and PDF conflicts discovered after binding unresolved reports", async () => {
    const created = await createOrGetFeedbackIntakeRun({
      sessionCode: sessionCodes[0],
      files: [
        intakeFile("合成助教表.xlsx", assistantWorkbook()),
        intakeFile("未归属-81.pdf", "%PDF bound-rate-81"),
        intakeFile("未归属-83.pdf", "%PDF bound-rate-83"),
      ],
      db: prisma,
    });
    const identityIssues = created.run.issues.filter((item) => item.code === "assessment_student_mismatch");
    expect(identityIssues).toHaveLength(2);
    expect(created.run.issues).not.toContainEqual(expect.objectContaining({ code: "assessment_duplicate" }));
    expect(created.run.issues).not.toContainEqual(expect.objectContaining({ code: "score_conflict" }));

    const reviewed = await resolveFeedbackIntakeRun(created.run.id, {
      action: "confirm",
      decisions: identityIssues.map((item) => ({
        issueId: item.id,
        action: "bind_student" as const,
        studentId: firstUniqueStudentId,
        sourceName: item.sourceName,
      })),
    }, prisma);
    expect(reviewed.status).toBe("needs_review");
    expect(reviewed.appliedSummary.decisions).toEqual(expect.arrayContaining(
      identityIssues.map((item) => expect.objectContaining({ issueId: item.id, action: "bind_student" })),
    ));
    const duplicate = reviewed.issues.find((item) => item.code === "assessment_duplicate")!;
    const conflict = reviewed.issues.find((item) => item.code === "score_conflict")!;
    expect(duplicate.assessmentDuplicate?.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ correctRate: 81, scoreA: 4.1 }),
      expect.objectContaining({ correctRate: 83, scoreA: 4.2 }),
    ]));
    expect(conflict.scoreConflict?.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceKind: "assistant_roster", score: 4 }),
      expect.objectContaining({ sourceKind: "assessment_pdf", score: 4.1 }),
      expect.objectContaining({ sourceKind: "assessment_pdf", score: 4.2 }),
    ]));

    const selectedEvidence = duplicate.assessmentDuplicate!.candidates.find((candidate) => candidate.correctRate === 83)!;
    const selectedScore = conflict.scoreConflict!.candidates.find((candidate) => (
      candidate.sourceKind === "assessment_pdf" && candidate.sourceId === selectedEvidence.id
    ))!;
    const confirmed = await resolveFeedbackIntakeRun(reviewed.id, {
      action: "confirm",
      decisions: [
        {
          issueId: duplicate.id,
          action: "select_pdf",
          studentId: duplicate.assessmentDuplicate!.studentId,
          sourceName: selectedEvidence.sourceName,
          candidateId: selectedEvidence.id,
        },
        { issueId: conflict.id, action: "use_score_candidate", candidateId: selectedScore.id },
      ],
    }, prisma);
    expect(confirmed).toMatchObject({ status: "applied" });
    expect(confirmed.appliedSummary.assessmentEvidence).toMatchObject({
      [firstUniqueStudentId]: { correctRate: 83 },
    });
  });

  it("removes stale dynamic conflicts when bound PDF rows are changed to skip", async () => {
    const created = await createOrGetFeedbackIntakeRun({
      sessionCode: sessionCodes[0],
      files: [
        intakeFile("合成助教表.xlsx", assistantWorkbook()),
        intakeFile("未归属-81.pdf", "%PDF rebound-rate-81"),
        intakeFile("未归属-83.pdf", "%PDF rebound-rate-83"),
      ],
      db: prisma,
    });
    const identityIssues = created.run.issues.filter((item) => item.code === "assessment_student_mismatch");
    const reviewed = await resolveFeedbackIntakeRun(created.run.id, {
      action: "confirm",
      decisions: identityIssues.map((item) => ({
        issueId: item.id,
        action: "bind_student" as const,
        studentId: firstUniqueStudentId,
        sourceName: item.sourceName,
      })),
    }, prisma);
    expect(reviewed.status).toBe("needs_review");
    expect(reviewed.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "assessment_duplicate" }),
      expect.objectContaining({ code: "score_conflict" }),
    ]));

    const confirmed = await resolveFeedbackIntakeRun(reviewed.id, {
      action: "confirm",
      decisions: identityIssues.map((item) => ({
        issueId: item.id,
        action: "skip_student" as const,
        sourceName: item.sourceName,
      })),
    }, prisma);
    expect(confirmed.status).toBe("applied");
    expect(confirmed.issues).not.toContainEqual(expect.objectContaining({ code: "assessment_duplicate" }));
    expect(confirmed.issues).not.toContainEqual(expect.objectContaining({ code: "score_conflict" }));
    expect(confirmed.appliedSummary.assessmentEvidence).toEqual({});
    await expect(prisma.sessionMetric.findUnique({
      where: { studentId_sessionId: { studentId: firstUniqueStudentId, sessionId: firstSessionId } },
    })).resolves.toMatchObject({ scoreA: 4, scoreB: 5, scoreC: 4 });
  });

  it("keeps same-named distinct PDFs across consecutive upload batches", async () => {
    const first = await createFeedbackGroupIntake({
      groupLessonId,
      sessionCodes: [sessionCodes[0]],
      files: [intakeFile("合成甲.pdf", "%PDF rate-81")],
      db: prisma,
    });
    const second = await createFeedbackGroupIntake({
      groupLessonId,
      sessionCodes: [sessionCodes[0]],
      runIds: { [sessionCodes[0]]: first.runs[0]!.id },
      files: [intakeFile("合成甲.pdf", "%PDF rate-82")],
      db: prisma,
    });
    const run = second.runs[0]!;
    const duplicate = run.issues.find((item) => item.code === "assessment_duplicate")!;
    expect(run.sourceManifest.filter((item) => item.name === "合成甲.pdf")).toHaveLength(2);
    expect(duplicate.assessmentDuplicate?.candidates).toHaveLength(2);
    expect(new Set(duplicate.assessmentDuplicate?.candidates.map((candidate) => candidate.id)).size).toBe(2);
    expect(duplicate.assessmentDuplicate?.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceName: "合成甲.pdf", correctRate: 81, scoreA: 4.1 }),
      expect.objectContaining({ sourceName: "合成甲.pdf", correctRate: 82, scoreA: 4.1 }),
    ]));
  });

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

  it("reuses a group run without consulting or rewriting its historical plan pointer", async () => {
    const prepared = await createFeedbackGroupIntake({ groupLessonId, files: [], db: prisma });
    const run = prepared.runs.find((item) => item.sessionCode === sessionCodes[0])!;
    const plan = await createFeedbackPlan({
      semesterId,
      classId: firstClassId,
      sessionId: firstSessionId,
      type: "event_micro",
      outputRequirement: "合成归档后重建",
      studentIds: [firstUniqueStudentId],
    }, prisma);
    await prisma.feedbackIntakeRun.update({ where: { id: run.id }, data: { planId: plan.id } });

    const retryInput = {
      groupLessonId,
      sessionCodes: [sessionCodes[0]],
      files: [] as IntakeFile[],
      runIds: { [sessionCodes[0]]: run.id },
      db: prisma,
    };
    try {
      const retried = await createFeedbackGroupIntake(retryInput);
      expect(retried.runs).toContainEqual(expect.objectContaining({ id: run.id, planId: null }));
      expect((await prisma.feedbackIntakeRun.findUniqueOrThrow({ where: { id: run.id } })).planId).toBe(plan.id);
    } finally {
      await prisma.feedbackIntakeRun.update({ where: { id: run.id }, data: { planId: null } });
      await prisma.feedbackPlan.deleteMany({ where: { id: plan.id } });
    }
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

  it("routes a mixed retry through the full group but only updates the pending selected class", async () => {
    const first = await createFeedbackGroupIntake({
      groupLessonId,
      files: [
        stepFile(`${marker}-01`, "合成一班", `${marker}-A`, "合成甲"),
        stepFile(`${marker}-02`, "合成二班", `${marker}-B`, "合成乙"),
      ],
      db: prisma,
    });
    const firstRun = first.runs.find((run) => run.sessionCode === sessionCodes[0])!;
    const secondRun = first.runs.find((run) => run.sessionCode === sessionCodes[1])!;
    await prisma.feedbackIntakeRun.update({
      where: { id: firstRun.id },
      data: { planId: `${marker}-PLAN-A` },
    });
    const firstRunBefore = await prisma.feedbackIntakeRun.findUniqueOrThrow({ where: { id: firstRun.id } });

    const result = await createFeedbackGroupIntake({
      groupLessonId,
      sessionCodes: [sessionCodes[1]],
      files: [
        intakeFile("子集重试两班助教表.xlsx", assistantWorkbook()),
        stepFile(`${marker}-01`, "合成一班", `${marker}-A`, "合成甲"),
        stepFile(`${marker}-02`, "合成二班", `${marker}-B`, "合成乙"),
        intakeFile("合成甲-未选班.pdf", "%PDF unselected-class"),
        intakeFile("合成乙-待处理班.pdf", "%PDF selected-class"),
        stepFile(`${marker}-OUTSIDE`, "组外班", `${marker}-OUTSIDE-STUDENT`, "组外学生"),
      ],
      runIds: { [sessionCodes[1]]: secondRun.id },
      db: prisma,
    });

    expect(result.classes).toHaveLength(1);
    expect(result.classes[0]).toMatchObject({ classId: secondClassId, sessionCode: sessionCodes[1], runId: secondRun.id });
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({ id: secondRun.id, sessionCode: sessionCodes[1] });
    const selectedSourceNames = result.runs[0]!.sourceManifest.map((source) => source.name);
    expect(selectedSourceNames).toEqual(expect.arrayContaining([
      "子集重试两班助教表.xlsx",
      `${marker}-02.step-classroom.txt`,
      "合成乙-待处理班.pdf",
    ]));
    expect(selectedSourceNames).not.toContain(`${marker}-01.step-classroom.txt`);
    expect(selectedSourceNames).not.toContain("合成甲-未选班.pdf");
    expect(selectedSourceNames).not.toContain(`${marker}-OUTSIDE.step-classroom.txt`);
    expect(result.unassigned).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fileName: "子集重试两班助教表.xlsx",
        kind: "assistant_roster",
        blocking: false,
        candidateClassIds: [firstClassId],
      }),
      expect.objectContaining({
        fileName: `${marker}-01.step-classroom.txt`,
        kind: "step_classroom",
        blocking: false,
        candidateClassIds: [firstClassId],
      }),
      expect.objectContaining({
        fileName: "合成甲-未选班.pdf",
        kind: "assessment_pdf",
        blocking: false,
        candidateClassIds: [firstClassId],
      }),
      expect.objectContaining({
        fileName: `${marker}-OUTSIDE.step-classroom.txt`,
        kind: "step_classroom",
        blocking: true,
      }),
    ]));
    const firstRunAfter = await prisma.feedbackIntakeRun.findUniqueOrThrow({ where: { id: firstRun.id } });
    expect(firstRunAfter).toMatchObject({
      planId: firstRunBefore.planId,
      sourceFingerprint: firstRunBefore.sourceFingerprint,
      sourceManifest: firstRunBefore.sourceManifest,
      appliedSummary: firstRunBefore.appliedSummary,
      status: firstRunBefore.status,
    });
    expect(firstRunAfter.updatedAt.getTime()).toBe(firstRunBefore.updatedAt.getTime());
  });

  it("rejects an empty or unrelated selected class subset", async () => {
    await expect(createFeedbackGroupIntake({
      groupLessonId,
      sessionCodes: [],
      files: [],
      db: prisma,
    })).rejects.toMatchObject({ status: 400 });

    await expect(createFeedbackGroupIntake({
      groupLessonId,
      sessionCodes: [`${marker}-NOT-IN-GROUP`],
      files: [],
      db: prisma,
    })).rejects.toMatchObject({ status: 409 });
  });

  it("rejects run IDs outside the selected class subset", async () => {
    const existing = await createFeedbackGroupIntake({ groupLessonId, files: [], db: prisma });
    const firstRun = existing.runs.find((run) => run.sessionCode === sessionCodes[0])!;

    await expect(createFeedbackGroupIntake({
      groupLessonId,
      sessionCodes: [sessionCodes[1]],
      files: [],
      runIds: { [sessionCodes[0]]: firstRun.id },
      db: prisma,
    })).rejects.toMatchObject({ status: 409 });
  });

  it("allows a direct service caller to prepare empty runs for every linked class", async () => {
    const result = await createFeedbackGroupIntake({ groupLessonId, files: [], db: prisma });
    expect(result.runs).toHaveLength(2);
    expect(result.classes.every((item) => Boolean(item.runId))).toBe(true);
    expect(result.sourceSummaries.every((summary) => summary.status === "empty")).toBe(true);
  });

  it("keeps the active peer usable while hiding a recycled class from group progress and intake", async () => {
    await prisma.class.update({ where: { id: secondClassId }, data: { deletedAt: new Date() } });

    try {
      const progress = await getSessionGroupProgress(firstSessionId, prisma);
      expect(progress?.status).toBe("linked");
      expect(progress?.lesson?.id).toBe(groupLessonId);
      expect(progress?.group.members).toHaveLength(1);
      expect(progress?.group.members.map((member) => ({
        classId: member.classId,
        sessionId: member.session?.id,
      }))).toEqual([{ classId: firstClassId, sessionId: firstSessionId }]);
      await expect(getSessionGroupProgress(secondSessionId, prisma)).rejects.toMatchObject({
        status: 409,
        code: "scope_in_recycle_bin",
      });

      const prepared = await prepareFeedbackGroupIntakeFromExistingFacts({ groupLessonId, db: prisma });
      expect(prepared.classes).toHaveLength(1);
      expect(prepared.classes[0]).toMatchObject({ classId: firstClassId, sessionCode: sessionCodes[0] });
      expect(prepared.runs).toHaveLength(1);
      expect(prepared.runs[0]).toMatchObject({ sessionCode: sessionCodes[0] });
    } finally {
      await prisma.class.update({ where: { id: secondClassId }, data: { deletedAt: null } });
    }
  });

  it("confirms existing facts independently without rewriting either class", async () => {
    const [firstMetric, secondMetric] = await Promise.all([
      prisma.sessionMetric.upsert({
        where: { studentId_sessionId: { studentId: firstUniqueStudentId, sessionId: firstSessionId } },
        create: { studentId: firstUniqueStudentId, sessionId: firstSessionId, date: "2099-05-01", scoreA: 5, scoreB: 4, scoreC: 3, scoreD: 2, operator: "teacher" },
        update: { scoreA: 5, scoreB: 4, scoreC: 3, scoreD: 2, operator: "teacher" },
      }),
      prisma.sessionMetric.upsert({
        where: { studentId_sessionId: { studentId: secondUniqueStudentId, sessionId: secondSessionId } },
        create: { studentId: secondUniqueStudentId, sessionId: secondSessionId, date: "2099-05-01", scoreA: 2, scoreB: 3, scoreC: 4, scoreD: 5, operator: "teacher" },
        update: { scoreA: 2, scoreB: 3, scoreC: 4, scoreD: 5, operator: "teacher" },
      }),
    ]);
    const [firstAttendance, secondAttendance] = await Promise.all([
      prisma.attendance.upsert({
        where: { sessionId_studentId: { sessionId: firstSessionId, studentId: firstUniqueStudentId } },
        create: { sessionId: firstSessionId, studentId: firstUniqueStudentId, present: true },
        update: { present: true },
      }),
      prisma.attendance.upsert({
        where: { sessionId_studentId: { sessionId: secondSessionId, studentId: secondUniqueStudentId } },
        create: { sessionId: secondSessionId, studentId: secondUniqueStudentId, present: false },
        update: { present: false },
      }),
    ]);
    const firstEventDescription = `${marker}-一班已有事实`;
    const secondEventDescription = `${marker}-二班已有事实`;
    const [firstEvent, secondEvent] = await Promise.all([
      prisma.event.upsert({
        where: { studentId_sessionId_description: { studentId: firstUniqueStudentId, sessionId: firstSessionId, description: firstEventDescription } },
        create: { studentId: firstUniqueStudentId, sessionId: firstSessionId, type: "课堂表现", description: firstEventDescription, rawText: "合成事实" },
        update: {},
      }),
      prisma.event.upsert({
        where: { studentId_sessionId_description: { studentId: secondUniqueStudentId, sessionId: secondSessionId, description: secondEventDescription } },
        create: { studentId: secondUniqueStudentId, sessionId: secondSessionId, type: "课堂表现", description: secondEventDescription, rawText: "合成事实" },
        update: {},
      }),
    ]);

    const prepared = await prepareFeedbackGroupIntakeFromExistingFacts({ groupLessonId, db: prisma });
    expect(prepared.runs).toHaveLength(2);
    for (const run of prepared.runs) {
      await resolveFeedbackIntakeRun(run.id, { action: "confirm", decisions: [] }, prisma);
    }

    await expect(prisma.sessionMetric.findUnique({ where: { id: firstMetric.id } })).resolves.toMatchObject({ scoreA: 5, scoreB: 4, scoreC: 3, scoreD: 2 });
    await expect(prisma.sessionMetric.findUnique({ where: { id: secondMetric.id } })).resolves.toMatchObject({ scoreA: 2, scoreB: 3, scoreC: 4, scoreD: 5 });
    await expect(prisma.attendance.findUnique({ where: { id: firstAttendance.id } })).resolves.toMatchObject({ present: true });
    await expect(prisma.attendance.findUnique({ where: { id: secondAttendance.id } })).resolves.toMatchObject({ present: false });
    await expect(prisma.event.findUnique({ where: { id: firstEvent.id } })).resolves.toMatchObject({ description: firstEventDescription });
    await expect(prisma.event.findUnique({ where: { id: secondEvent.id } })).resolves.toMatchObject({ description: secondEventDescription });
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
