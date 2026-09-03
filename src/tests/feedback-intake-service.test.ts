import { deflateRawSync } from "node:zlib";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { STEP_CLASSROOM_HEADER, STEP_INTERPRETATION_PROMPT, STEP_PROMPT_VERSION } from "@/services/step-classroom-import-service";
import { prisma } from "@/lib/prisma";
import { archiveFeedbackPlan } from "@/services/feedback-plan-service";
import {
  classifyFeedbackIntakeFile,
  createOrGetFeedbackIntakeRun,
  clearFeedbackIntakeScope,
  confirmFeedbackIntakeScope,
  expandFeedbackIntakeFiles,
  inspectFeedbackIntake,
  prepareFeedbackIntakeFromExistingFacts,
  resolveFeedbackIntakeRun,
  resolveIntakeStudentIdentity,
  type IntakeFile,
} from "@/services/feedback-intake-service";

function zipSingle(name: string, content: string, flags = 0) {
  const nameBuffer = Buffer.from(name);
  const source = Buffer.from(content);
  const compressed = deflateRawSync(source);
  const local = Buffer.alloc(30 + nameBuffer.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(nameBuffer.length, 26);
  nameBuffer.copy(local, 30);
  const central = Buffer.alloc(46 + nameBuffer.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(flags, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(source.length, 24);
  central.writeUInt16LE(nameBuffer.length, 28);
  nameBuffer.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + compressed.length, 16);
  const result = Buffer.concat([local, compressed, central, end]);
  const arrayBuffer = new ArrayBuffer(result.byteLength);
  new Uint8Array(arrayBuffer).set(result);
  return arrayBuffer;
}

function file(name: string, buffer: ArrayBuffer): IntakeFile {
  return { name, buffer, source: "upload" };
}

function textBuffer(value: string) {
  const encoded = new TextEncoder().encode(value);
  return encoded.buffer;
}

function assistantFile(rows: unknown[][], date = "2026-07-08", lesson = "2", name = "合成助教表.xlsx") {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["日期", date, "课次", lesson],
    ["姓名", "听课证号", "班级编号", "班级名称", "出门测", "课堂纪律", "课后作业", "备注"],
    ...rows,
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, "课堂记录");
  return file(name, XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

function stepFile(completedAt = "2026-07-08T10:00:00+08:00", notes: Array<{ contextQuestionIndex: number; text: string; recordedAt: string }> = []) {
  const payload = {
    class: { code: "E2E-CLASS", name: "E2E测试班" },
    stepSessionId: "beta3-step-test",
    title: "课后课堂观察",
    startedAt: "2026-07-08T09:00:00+08:00",
    completedAt,
    questionCount: 1,
    students: [{
      studentId: "E2E-001",
      name: "测试甲",
      present: true,
      observations: [{
        questionIndex: 1,
        semanticAnchor: "fastIndependent",
        semanticText: "独立完成",
        followUpAction: null,
        recordedAt: "2026-07-08T09:30:00+08:00",
      }],
      notes,
    }],
  };
  return file("课堂.step-classroom.txt", textBuffer(`${STEP_CLASSROOM_HEADER}\nPROMPT_VERSION: ${STEP_PROMPT_VERSION}\n\n=== DATA BEGIN ===\n${JSON.stringify(payload)}\n=== DATA END ===\n=== PROMPT BEGIN ===\n${STEP_INTERPRETATION_PROMPT}\n=== PROMPT END ===`));
}

describe("feedback intake file preparation", () => {
  it("matches assistant rows by class and student before checking the session", async () => {
    const inspection = await inspectFeedbackIntake({
      sessionCode: "2026070801",
      files: [assistantFile([
        ["测试甲", "E2E-001", "E2E-CLASS", "E2E测试班", 5, 5, 4, "合成正常记录"],
        ["测试未入册", "TEST20999999", "E2E-CLASS", "E2E测试班", 3, 3, 3, "合成异常记录"],
      ], "2026-07-09", "3")],
      db: prisma,
    });
    const fact = inspection.sourceFacts?.find((item) => item.kind === "assistant_roster");
    expect(fact?.assistantMatch).toEqual({ matchedClass: true, matchedStudents: 1, totalStudentRows: 2, sessionStatus: "mismatch" });
    expect(fact?.issues.map((item) => item.stage)).toEqual(["student", "session", "session"]);
    expect(fact?.issues[0]).toMatchObject({
      code: "student_mismatch",
      rowNumber: 4,
      reportedStudent: { name: "测试未入册", studentId: "TEST20999999" },
      rosterHint: "学生库中没有找到该学生",
    });
  });

  it("skips one unmatched assistant row without discarding matched students from the file", async () => {
    const marker = crypto.randomUUID();
    const semesterId = `skip-semester-${marker}`;
    const classId = `skip-class-${marker}`;
    const sessionCode = `skip-session-${marker}`;
    const students = [
      { id: `skip-student-a-${marker}`, name: "测试甲", studentId: `SKIPA${marker.replaceAll("-", "").slice(0, 10)}`, gender: "男" },
      { id: `skip-student-b-${marker}`, name: "测试乙", studentId: `SKIPB${marker.replaceAll("-", "").slice(0, 10)}`, gender: "女" },
    ];
    await prisma.semester.create({ data: { id: semesterId, name: `按行跳过-${marker}`, startDate: "2098-01-01", endDate: "2098-12-31" } });
    await prisma.class.create({ data: { id: classId, semesterId, code: `SKIP-${marker}`, name: "按行跳过测试班" } });
    for (const student of students) {
      await prisma.student.create({ data: student });
      await prisma.studentClassEnrollment.create({ data: { studentId: student.id, semesterId, classId } });
    }
    await prisma.classSession.create({ data: { code: sessionCode, date: "2098-07-08", semesterNumber: 2, semesterId, classId } });
    try {
      const result = await createOrGetFeedbackIntakeRun({
        sessionCode,
        files: [
          assistantFile([
            ["测试甲", students[0].studentId, `SKIP-${marker}`, "按行跳过测试班", 5, 5, 4, "合成正常记录"],
            ["测试乙", students[1].studentId, `SKIP-${marker}`, "按行跳过测试班", 4, 4, 5, "合成正常记录"],
          ], "2098-07-08", "2", "完整助教表.xlsx"),
          assistantFile([
            ["测试甲", students[0].studentId, `SKIP-${marker}`, "按行跳过测试班", 5, 5, 4, "重复但一致的有效记录"],
            ["测试未入册", "TEST20999999", `SKIP-${marker}`, "按行跳过测试班", 3, 3, 3, "合成异常记录"],
          ], "2098-07-08", "2", "异常助教表.xlsx"),
        ],
        db: prisma,
      });
      const mismatch = result.run.issues.find((item) => item.code === "student_mismatch");
      expect(mismatch).toBeDefined();
      const legacySnapshot = {
        ...structuredClone(result.run.appliedSummary),
        sourceFacts: structuredClone(result.inspection.sourceFacts ?? []),
      };
      const partialFact = legacySnapshot.sourceFacts.find((fact) => fact.unresolvedStudents?.length);
      partialFact?.parsedResult?.students.push({
        name: "测试乙",
        scores: { A: null, B: null, C: null },
        events: [],
        communication: null,
        present: false,
      });
      await prisma.feedbackIntakeRun.update({
        where: { id: result.run.id },
        data: { appliedSummary: JSON.stringify(legacySnapshot) },
      });
      const confirmed = await resolveFeedbackIntakeRun(result.run.id, {
        action: "confirm",
        decisions: [{ issueId: mismatch!.id, action: "skip_student", sourceName: mismatch!.sourceName }],
      }, prisma);
      expect(confirmed.status).toBe("applied");
      expect(confirmed.appliedSummary.appliedStudentCount).toBe(2);
    } finally {
      await prisma.feedbackIntakeRun.deleteMany({ where: { sessionCode } });
      await prisma.classSession.deleteMany({ where: { code: sessionCode } });
      await prisma.studentClassEnrollment.deleteMany({ where: { semesterId } });
      await prisma.class.deleteMany({ where: { id: classId } });
      await prisma.semester.deleteMany({ where: { id: semesterId } });
      await prisma.student.deleteMany({ where: { id: { in: students.map((student) => student.id) } } });
    }
  }, 20_000);

  it("falls back only when the reported student number is unknown", () => {
    const roster = [
      { id: "student-a", name: "测试甲", studentId: "E2E-001" },
      { id: "student-b", name: "测试乙", studentId: "E2E-002" },
    ];
    expect(resolveIntakeStudentIdentity(roster, "OLD-001", "测试甲")).toMatchObject({ match: roster[0], conflict: false });
    expect(resolveIntakeStudentIdentity(roster, "E2E-002", "测试甲")).toMatchObject({ match: undefined, conflict: true });
    expect(resolveIntakeStudentIdentity(roster, "", "测试甲")).toMatchObject({ match: roster[0], conflict: false });
  });

  it("does not let a source-level date acceptance resolve an identity conflict from the same source", async () => {
    const run = await prisma.feedbackIntakeRun.create({
      data: {
        sessionCode: "2026070801",
        sourceFingerprint: `SOURCE-SCOPE-${crypto.randomUUID()}`,
        sourceManifest: "[]",
        status: "needs_review",
        issues: JSON.stringify([
          { id: "date", code: "assessment_date_mismatch", message: "日期不一致", severity: "requires_teacher", sourceName: "同一来源.pdf" },
          { id: "identity", code: "assessment_identity_conflict", message: "身份冲突", severity: "requires_teacher", sourceName: "同一来源.pdf" },
        ]),
        appliedSummary: JSON.stringify({ applied: false, parsedResult: { students: [], alert_suggestion: "" }, assessmentEvidence: {}, sourceFacts: [] }),
      },
    });
    await expect(resolveFeedbackIntakeRun(run.id, {
      action: "confirm",
      decisions: [{ issueId: "date", action: "accept_source", sourceName: "同一来源.pdf" }],
    }, prisma)).rejects.toThrow("还有 1 项材料异常未处理");
    await prisma.feedbackIntakeRun.delete({ where: { id: run.id } });
  });

  it("classifies supported sources and ignores unrelated files", () => {
    expect(classifyFeedbackIntakeFile("助教课堂.xlsx")).toBe("assistant_roster");
    expect(classifyFeedbackIntakeFile("step-classroom.txt")).toBe("step_classroom");
    expect(classifyFeedbackIntakeFile("说明.txt")).toBe("ignored");
    expect(classifyFeedbackIntakeFile("张三.pdf")).toBe("assessment_pdf");
    expect(classifyFeedbackIntakeFile("说明.docx")).toBe("ignored");
    expect(classifyFeedbackIntakeFile("报告目录/~$课堂记录.xlsx")).toBe("ignored");
  });

  it("expands a ZIP only for this run", () => {
    const expanded = expandFeedbackIntakeFiles([file("课后材料.zip", zipSingle("课堂.step-classroom.txt", "STEP"))]);
    expect(expanded).toHaveLength(1);
    expect(expanded[0]?.displayName).toBe("课后材料.zip / 课堂.step-classroom.txt");
    expect(new TextDecoder().decode(expanded[0]?.buffer)).toBe("STEP");
  });

  it("rejects encrypted and nested ZIP entries", () => {
    expect(() => expandFeedbackIntakeFiles([file("加密.zip", zipSingle("课堂.txt", "STEP", 1))])).toThrow("加密");
    expect(() => expandFeedbackIntakeFiles([file("嵌套.zip", zipSingle("另一个.zip", "ZIP"))])).toThrow("嵌套");
  });

  it("keeps STEP facts deterministic and makes repeated scans idempotent", async () => {
    const input = { sessionCode: "2026070801", files: [stepFile()], db: prisma };
    const inspection = await inspectFeedbackIntake(input);
    expect(inspection.issues).toEqual([]);
    expect(inspection.parsedResult.students).toHaveLength(1);
    expect(inspection.parsedResult.students[0]).toMatchObject({
      studentId: "E2E-001",
      present: true,
      scores: { A: null, B: null, C: null },
    });

    const first = await createOrGetFeedbackIntakeRun(input);
    const second = await createOrGetFeedbackIntakeRun(input);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    await prisma.feedbackIntakeRun.delete({ where: { id: first.run.id } });
  });

  it("lets the same material run be scanned again after its plan is archived", async () => {
    const input = { sessionCode: "2026070801", files: [stepFile()], db: prisma };
    const prepared = await createOrGetFeedbackIntakeRun(input);
    await resolveFeedbackIntakeRun(prepared.run.id, { action: "confirm", decisions: [] }, prisma);
    const created = await resolveFeedbackIntakeRun(prepared.run.id, {
      action: "create_plan",
      plan: { type: "event_micro", outputRequirement: "归档后复用相同材料" },
    }, prisma);
    if (!("plan" in created) || !created.plan) throw new Error("合成反馈计划创建失败");

    try {
      await expect(createOrGetFeedbackIntakeRun({ ...input, runId: prepared.run.id })).rejects.toThrow("已经关联");
      await archiveFeedbackPlan(created.plan.id, prisma);
      const retried = await createOrGetFeedbackIntakeRun({ ...input, runId: prepared.run.id });
      expect(retried).toMatchObject({ duplicate: true, run: { id: prepared.run.id, planId: null, status: "applied" } });
    } finally {
      await prisma.feedbackIntakeRun.deleteMany({ where: { id: prepared.run.id } });
      await prisma.feedbackPlan.deleteMany({ where: { id: created.plan.id } });
    }
  });

  it("reuses an existing complete batch when a restored empty run has the same fingerprint", async () => {
    const existing = await createOrGetFeedbackIntakeRun({ sessionCode: "2026070801", files: [stepFile()], db: prisma });
    const restoredEmpty = await createOrGetFeedbackIntakeRun({ sessionCode: "2026070801", files: [], db: prisma });
    const resumed = await createOrGetFeedbackIntakeRun({ sessionCode: "2026070801", files: [stepFile()], runId: restoredEmpty.run.id, db: prisma });
    expect(resumed.duplicate).toBe(true);
    expect(resumed.run.id).toBe(existing.run.id);
    await prisma.feedbackIntakeRun.deleteMany({ where: { id: { in: [existing.run.id, restoredEmpty.run.id] } } });
  });

  it("does not write a date-mismatched STEP file before teacher confirmation", async () => {
    const input = { sessionCode: "2026070801", files: [stepFile("2026-07-09T10:00:00+08:00")], db: prisma };
    const before = await prisma.draftRecord.count();
    const inspection = await inspectFeedbackIntake(input);
    expect(inspection.issues.some((item) => item.code === "step_date_mismatch")).toBe(true);
    expect(inspection.parsedResult.students).toHaveLength(0);
    const result = await createOrGetFeedbackIntakeRun(input);
    expect(result.run.status).toBe("needs_review");
    expect(await prisma.draftRecord.count()).toBe(before);
    await prisma.feedbackIntakeRun.delete({ where: { id: result.run.id } });
  });

  it("requires an explicit decision for STEP free notes and persists an edited observation", async () => {
    const input = {
      sessionCode: "2026070801",
      files: [stepFile("2026-07-08T10:00:00+08:00", [{ contextQuestionIndex: 1, text: "原始自由备注", recordedAt: "2026-07-08T09:45:00+08:00" }])],
      db: prisma,
    };
    const result = await createOrGetFeedbackIntakeRun(input);
    const noteIssue = result.run.issues.find((item) => item.code === "step_note_review");
    expect(noteIssue).toBeDefined();
    await expect(resolveFeedbackIntakeRun(result.run.id, { action: "confirm", decisions: [] }, prisma)).rejects.toThrow("材料异常未处理");
    const confirmed = await resolveFeedbackIntakeRun(result.run.id, {
      action: "confirm",
      decisions: [{ issueId: noteIssue!.id, action: "edit_observation", text: "教师确认后的课堂观察" }],
    }, prisma);
    expect(confirmed.status).toBe("applied");
    const saved = await prisma.draftRecord.findFirst({ where: { sessionCode: "2026070801" }, orderBy: { createdAt: "desc" } });
    expect(saved?.parsedResult).toContain("教师确认后的课堂观察");
    await prisma.feedbackIntakeRun.delete({ where: { id: result.run.id } });
  }, 20_000);

  it("writes a confirmed STEP run once and keeps retry idempotent", async () => {
    const input = { sessionCode: "2026070801", files: [stepFile()], db: prisma };
    const result = await createOrGetFeedbackIntakeRun(input);
    const before = await prisma.draftRecord.count();
    const confirmed = await resolveFeedbackIntakeRun(result.run.id, { action: "confirm", decisions: [] }, prisma);
    expect(confirmed.status).toBe("applied");
    expect(await prisma.draftRecord.count()).toBe(before + 1);
    const repeated = await resolveFeedbackIntakeRun(result.run.id, { action: "confirm", decisions: [] }, prisma);
    expect(repeated.status).toBe("applied");
    expect(await prisma.draftRecord.count()).toBe(before + 1);
    await prisma.feedbackIntakeRun.delete({ where: { id: result.run.id } });
  }, 20_000);

  it("confirms no-new-material intake without rewriting existing classroom facts", async () => {
    const marker = crypto.randomUUID();
    const sessionCode = `existing-facts-${marker}`;
    const student = await prisma.student.findFirstOrThrow({ where: { studentId: "E2E-001" } });
    const session = await prisma.classSession.create({
      data: {
        code: sessionCode,
        date: "2097-06-01",
        semesterNumber: 98,
        semesterId: "test-semester-1",
        classId: "test-class-1",
      },
    });
    const metric = await prisma.sessionMetric.create({
      data: {
        studentId: student.id,
        sessionId: session.id,
        date: session.date,
        scoreA: 5,
        scoreB: 4,
        scoreC: 3,
        scoreD: 2,
        operator: "teacher",
      },
    });
    const attendance = await prisma.attendance.create({
      data: { studentId: student.id, sessionId: session.id, present: false },
    });
    const event = await prisma.event.create({
      data: {
        studentId: student.id,
        sessionId: session.id,
        type: "课堂表现",
        description: `已确认的合成课堂事实-${marker}`,
        rawText: "教师已确认的合成测试事实",
      },
    });
    const draftsBefore = await prisma.draftRecord.count({ where: { sessionCode } });

    try {
      const prepared = await prepareFeedbackIntakeFromExistingFacts({ sessionCode, db: prisma });
      expect(prepared.run).toMatchObject({ status: "ready", sourceManifest: [] });

      const confirmed = await resolveFeedbackIntakeRun(prepared.run.id, { action: "confirm", decisions: [] }, prisma);
      expect(confirmed).toMatchObject({
        status: "applied",
        appliedSummary: { applied: true, appliedStudentCount: 0 },
      });
      await expect(prisma.draftRecord.count({ where: { sessionCode } })).resolves.toBe(draftsBefore);
      await expect(prisma.sessionMetric.findUnique({ where: { id: metric.id } })).resolves.toMatchObject({
        scoreA: 5,
        scoreB: 4,
        scoreC: 3,
        scoreD: 2,
        operator: "teacher",
      });
      await expect(prisma.attendance.findUnique({ where: { id: attendance.id } })).resolves.toMatchObject({ present: false });
      await expect(prisma.event.findUnique({ where: { id: event.id } })).resolves.toMatchObject({
        description: `已确认的合成课堂事实-${marker}`,
      });
    } finally {
      await prisma.feedbackIntakeRun.deleteMany({ where: { sessionCode } });
      await prisma.classSession.deleteMany({ where: { id: session.id } });
    }
  }, 20_000);

  it("persists the confirmed class scope and clears it without deleting confirmed facts", async () => {
    const result = await createOrGetFeedbackIntakeRun({ sessionCode: "2026070801", files: [stepFile()], db: prisma });
    await resolveFeedbackIntakeRun(result.run.id, { action: "confirm", decisions: [] }, prisma);
    const session = await prisma.classSession.findUniqueOrThrow({ where: { code: "2026070801" } });
    const student = await prisma.student.findFirstOrThrow({ where: { studentId: "E2E-001" } });
    const beforeFacts = await prisma.draftRecord.count({ where: { sessionCode: "2026070801" } });

    const scoped = await confirmFeedbackIntakeScope(result.run.id, {
      classId: session.classId!,
      sessionCode: session.code,
      studentIds: [student.id],
    }, prisma);
    expect(scoped.appliedSummary.scopeConfirmation).toMatchObject({
      classId: session.classId,
      sessionCode: session.code,
      studentIds: [student.id],
    });

    const cleared = await clearFeedbackIntakeScope(result.run.id, prisma);
    expect(cleared.appliedSummary.scopeConfirmation).toBeUndefined();
    await expect(prisma.draftRecord.count({ where: { sessionCode: "2026070801" } })).resolves.toBe(beforeFacts);
    await prisma.feedbackIntakeRun.delete({ where: { id: result.run.id } });
  }, 20_000);

  it("creates independent plans from the same confirmed intake facts", async () => {
    const student = await prisma.student.findFirst({ where: { studentId: "E2E-001" }, select: { id: true } });
    expect(student).not.toBeNull();
    const sessionCode = "2096010101";
    const session = await prisma.classSession.create({
      data: {
        code: sessionCode,
        date: "2096-01-01",
        semesterNumber: 99,
        semesterId: "test-semester-1",
        classId: "test-class-1",
      },
    });
    const run = await prisma.feedbackIntakeRun.create({
      data: {
        sessionCode,
        sourceFingerprint: `CREATE-PLAN-${crypto.randomUUID()}`,
        sourceManifest: "[]",
        status: "applied",
        issues: "[]",
        appliedSummary: JSON.stringify({
          applied: true,
          assessmentEvidence: {},
          scopeConfirmation: {
            classId: "test-class-1",
            sessionCode,
            studentIds: [student!.id],
            confirmedAt: new Date().toISOString(),
          },
        }),
      },
    });
    const planInput = {
      type: "event_micro" as const,
      outputRequirement: "为测试学生生成一条可复核反馈",
      studentIds: [student!.id],
      generationPreferences: { closureType: "positive_recognition" as const, moduleKeys: ["observed_moment", "teacher_interpretation"], length: "detailed" as const, tone: "gentle" as const },
    };
    try {
      const first = await resolveFeedbackIntakeRun(run.id, { action: "create_plan", plan: planInput }, prisma);
      const second = await resolveFeedbackIntakeRun(run.id, { action: "create_plan", plan: planInput }, prisma);
      expect("plan" in first && "plan" in second ? first.plan?.id : null).not.toBe("plan" in second ? second.plan?.id : null);
      const keyedInput = { ...planInput, requestKey: `intake-draft-${crypto.randomUUID()}` };
      const keyed = await resolveFeedbackIntakeRun(run.id, { action: "create_plan", plan: keyedInput }, prisma);
      const repeatedKeyed = await resolveFeedbackIntakeRun(run.id, { action: "create_plan", plan: keyedInput }, prisma);
      expect("plan" in repeatedKeyed ? repeatedKeyed.plan?.id : null).toBe("plan" in keyed ? keyed.plan?.id : null);
      const anotherKey = await resolveFeedbackIntakeRun(run.id, {
        action: "create_plan",
        plan: { ...planInput, requestKey: `intake-draft-${crypto.randomUUID()}` },
      }, prisma);
      expect("plan" in anotherKey ? anotherKey.plan?.id : null).not.toBe("plan" in keyed ? keyed.plan?.id : null);
      const currentFactsRevision = await resolveFeedbackIntakeRun(run.id, {
        action: "create_plan",
        plan: {
          ...planInput,
          requestKey: `intake-current-facts-${crypto.randomUUID()}`,
          displayName: "当前事实修正版",
          basedOnPlanId: "plan" in first ? first.plan?.id : undefined,
        },
      }, prisma);
      expect("plan" in currentFactsRevision ? currentFactsRevision.plan : null).toMatchObject({
        displayName: "当前事实修正版",
        basedOnPlanId: "plan" in first ? first.plan?.id : null,
      });
      const stored = "plan" in first && first.plan ? JSON.parse(first.plan.inputSnapshot) : null;
      expect(stored?.generationPreferences).toMatchObject({ length: "detailed", tone: "gentle" });
      const planIds = [
        "plan" in first ? first.plan?.id : null,
        "plan" in second ? second.plan?.id : null,
        "plan" in keyed ? keyed.plan?.id : null,
        "plan" in anotherKey ? anotherKey.plan?.id : null,
        "plan" in currentFactsRevision ? currentFactsRevision.plan?.id : null,
      ]
        .filter((planId): planId is string => Boolean(planId));
      await prisma.feedbackPlan.deleteMany({ where: { id: { in: planIds } } });
    } finally {
      await prisma.feedbackIntakeRun.deleteMany({ where: { id: run.id } });
      await prisma.classSession.deleteMany({ where: { id: session.id } });
    }
  }, 20_000);
});
