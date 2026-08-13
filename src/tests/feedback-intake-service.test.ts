import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { STEP_CLASSROOM_HEADER, STEP_INTERPRETATION_PROMPT, STEP_PROMPT_VERSION } from "@/services/step-classroom-import-service";
import { prisma } from "@/lib/prisma";
import {
  classifyFeedbackIntakeFile,
  createOrGetFeedbackIntakeRun,
  expandFeedbackIntakeFiles,
  inspectFeedbackIntake,
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
  it("falls back from an unknown student number to one unique roster name", () => {
    const roster = [
      { id: "student-a", name: "测试甲", studentId: "E2E-001" },
      { id: "student-b", name: "测试乙", studentId: "E2E-002" },
    ];
    expect(resolveIntakeStudentIdentity(roster, "OLD-001", "测试甲")).toMatchObject({ match: roster[0], conflict: false });
    expect(resolveIntakeStudentIdentity(roster, "E2E-002", "测试甲")).toMatchObject({ match: undefined, conflict: true });
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

  it("returns the same plan when create_plan is retried", async () => {
    const input = { sessionCode: "2026070801", files: [stepFile()], db: prisma };
    const result = await createOrGetFeedbackIntakeRun(input);
    await resolveFeedbackIntakeRun(result.run.id, { action: "confirm", decisions: [] }, prisma);
    const student = await prisma.student.findFirst({ where: { studentId: "E2E-001" }, select: { id: true } });
    expect(student).not.toBeNull();
    const planInput = {
      type: "event_micro" as const,
      outputRequirement: "为测试学生生成一条可复核反馈",
      studentIds: [student!.id],
      generationPreferences: { closureType: "positive_recognition" as const, moduleKeys: ["observed_moment", "teacher_interpretation"], length: "detailed" as const, tone: "gentle" as const },
    };
    const first = await resolveFeedbackIntakeRun(result.run.id, { action: "create_plan", plan: planInput }, prisma);
    const second = await resolveFeedbackIntakeRun(result.run.id, { action: "create_plan", plan: planInput }, prisma);
    expect("plan" in first && "plan" in second ? first.plan?.id : null).toBe("plan" in second ? second.plan?.id : null);
    const stored = "plan" in first && first.plan ? JSON.parse(first.plan.inputSnapshot) : null;
    expect(stored?.generationPreferences).toMatchObject({ length: "detailed", tone: "gentle" });
    await prisma.feedbackIntakeRun.delete({ where: { id: result.run.id } });
  }, 20_000);
});
