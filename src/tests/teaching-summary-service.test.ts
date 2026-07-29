import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ completionCreate: vi.fn() }));

vi.mock("@/lib/llm", () => ({
  createLLMClient: () => ({ chat: { completions: { create: mocks.completionCreate } } }),
  getLLMModel: () => "test-teaching-model",
  getLLMCompletionOptions: () => ({ reasoning_effort: "low" }),
}));
import { TEST_FIXTURE } from "../../scripts/test-fixture-data";
import { TeachingSummaryRequestSchema } from "@/lib/contracts/teaching-summary";
import { prisma } from "@/lib/prisma";
import {
  buildTeachingSummaryContext,
  generateTeachingSummary,
  getTeachingSummary,
} from "@/services/teaching-summary-service";
import {
  persistObservationCandidates,
  updateTeacherObservationStatus,
} from "@/services/teacher-observation-service";

afterEach(async () => {
  await prisma.teacherObservation.deleteMany();
  await prisma.teachingSummaryCache.deleteMany();
  await prisma.communication.deleteMany({ where: { sourceKey: { startsWith: "test-summary-" } } });
});

beforeEach(() => {
  mocks.completionCreate.mockReset();
});

describe("teaching summary facts", () => {
  it("builds deterministic session and date facts without calling an LLM", async () => {
    const sessionRequest = TeachingSummaryRequestSchema.parse({
      scope: { type: "session", sessionCode: TEST_FIXTURE.sessions[0].code },
      includeCommunications: true,
    });
    const session = await buildTeachingSummaryContext(sessionRequest);
    expect(session.facts.totals).toMatchObject({
      sessionCount: 1,
      classCount: 1,
      coveredStudentCount: 2,
      metricRecordedCount: 2,
      attendanceRecordedCount: 2,
      eventCount: 1,
      communicationCount: 1,
      missingFeedbackHistoryCount: 0,
    });
    expect(session.facts.sessions[0]).toMatchObject({
      averages: { A: 3, B: 3, C: 3, D: 5 },
      feedbackHistoryFound: true,
    });

    const dateRequest = TeachingSummaryRequestSchema.parse({
      scope: { type: "date", semesterId: TEST_FIXTURE.semester.id, date: TEST_FIXTURE.sessions[1].date },
      includeCommunications: false,
    });
    const date = await getTeachingSummary(dateRequest);
    expect(date.analysis).toBeNull();
    expect(date.cache.status).toBe("miss");
    expect(date.facts.totals).toMatchObject({
      sessionCount: 1,
      pendingDraftCount: 1,
      communicationCount: 0,
      missingFeedbackHistoryCount: 1,
    });
    expect(date.facts.pendingItems.map((item) => item.type)).toEqual(expect.arrayContaining([
      "missing-metrics", "pending-drafts", "feedback-history-missing",
    ]));
  });

  it("excludes inactive roster-only students but preserves inactive historical participants", async () => {
    const inactiveRosterOnlyId = "test-summary-inactive-roster-only";
    await prisma.student.create({
      data: {
        id: inactiveRosterOnlyId,
        name: "非活跃无历史",
        studentId: "TEST-INACTIVE-NO-HISTORY",
        gender: "女",
        classId: TEST_FIXTURE.class.id,
        rosterStatus: "INACTIVE",
        statusEffectiveAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    });
    await prisma.student.update({
      where: { id: TEST_FIXTURE.students[0].id },
      data: { rosterStatus: "INACTIVE", statusEffectiveAt: new Date("2026-06-01T00:00:00.000Z") },
    });
    try {
      const context = await buildTeachingSummaryContext(TeachingSummaryRequestSchema.parse({
        scope: { type: "session", sessionCode: TEST_FIXTURE.sessions[0].code },
        includeCommunications: true,
      }));
      const names = [...context.references.students.values()].map((student) => student.name);
      expect(names).toContain(TEST_FIXTURE.students[0].name);
      expect(names).not.toContain("非活跃无历史");
    } finally {
      await prisma.student.update({
        where: { id: TEST_FIXTURE.students[0].id },
        data: { rosterStatus: "ACTIVE", statusEffectiveAt: new Date() },
      });
      await prisma.student.delete({ where: { id: inactiveRosterOnlyId } });
    }
  });

  it("uses one structured request, validates references and reuses the cache", async () => {
    const request = TeachingSummaryRequestSchema.parse({
      scope: { type: "session", sessionCode: TEST_FIXTURE.sessions[0].code },
      includeCommunications: true,
    });
    const context = await buildTeachingSummaryContext(request);
    const studentRef = context.references.students.keys().next().value;
    const sessionRef = context.references.sessions.keys().next().value;
    const communicationRef = context.references.communications.keys().next().value;
    expect(studentRef && sessionRef && communicationRef).toBeTruthy();
    mocks.completionCreate.mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            overview: "本次课的确定性事实完整。",
            classComparisons: [],
            noteworthyChanges: [{
              title: "课堂表现",
              detail: "该生有明确课堂记录。",
              studentRefs: [studentRef],
              sessionRefs: [sessionRef],
              communicationRefs: [],
            }],
            suggestedActions: [],
            observationCandidates: [{
              studentRef,
              kind: "classroom-alignment",
              topic: "parent-concern",
              title: "课堂与家长关切一致",
              evidenceSummary: "课堂记录与已确认沟通形成呼应。",
              communicationRefs: [communicationRef],
              sessionRefs: [sessionRef],
            }],
          }),
        },
      }],
    });

    const generated = await generateTeachingSummary(request);
    expect(generated.analysis?.overview).toContain("确定性事实");
    expect(generated.observations).toHaveLength(1);
    expect(mocks.completionCreate).toHaveBeenCalledTimes(1);
    expect(mocks.completionCreate).toHaveBeenCalledWith(expect.objectContaining({
      response_format: expect.objectContaining({ type: "json_schema" }),
      reasoning_effort: "low",
    }));

    const cached = await generateTeachingSummary(request);
    expect(cached.cache.status).toBe("hit");
    expect(mocks.completionCreate).toHaveBeenCalledTimes(1);
  });

  it("falls back when the configured provider rejects strict JSON Schema", async () => {
    const request = TeachingSummaryRequestSchema.parse({
      scope: { type: "session", sessionCode: TEST_FIXTURE.sessions[0].code },
      includeCommunications: false,
      forceRefresh: true,
    });
    mocks.completionCreate
      .mockRejectedValueOnce(Object.assign(new Error("response_format is unsupported"), { status: 400 }))
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              overview: "已按兼容模式生成解读。",
              classComparisons: [],
              noteworthyChanges: [],
              suggestedActions: [],
              observationCandidates: [],
            }),
          },
        }],
      });

    const generated = await generateTeachingSummary(request);
    expect(generated.analysis?.overview).toContain("兼容模式");
    expect(mocks.completionCreate).toHaveBeenCalledTimes(2);
    expect(mocks.completionCreate.mock.calls[1][0].response_format).toEqual({ type: "json_object" });
  });

  it("corrects one structurally invalid model response before persisting", async () => {
    const request = TeachingSummaryRequestSchema.parse({
      scope: { type: "session", sessionCode: TEST_FIXTURE.sessions[0].code },
      includeCommunications: false,
      forceRefresh: true,
    });
    mocks.completionCreate
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ observationCandidates: [] }) } }],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({
          overview: "纠错后结构完整。",
          classComparisons: [],
          noteworthyChanges: [],
          suggestedActions: [],
          observationCandidates: [],
        }) } }],
      });

    const generated = await generateTeachingSummary(request);
    expect(generated.analysis?.overview).toContain("纠错后");
    expect(mocks.completionCreate).toHaveBeenCalledTimes(2);
    expect(mocks.completionCreate.mock.calls[1][0].response_format).toBeUndefined();
  });

  it("rejects an interpretation that cites an unknown short reference", async () => {
    mocks.completionCreate.mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            overview: null,
            classComparisons: [{
              title: "无效引用",
              detail: "不得接受模型虚构来源。",
              studentRefs: ["S999"],
              sessionRefs: [],
              communicationRefs: [],
            }],
            noteworthyChanges: [],
            suggestedActions: [],
            observationCandidates: [],
          }),
        },
      }],
    });
    const request = TeachingSummaryRequestSchema.parse({
      scope: { type: "session", sessionCode: TEST_FIXTURE.sessions[0].code },
      includeCommunications: true,
      forceRefresh: true,
    });
    await expect(generateTeachingSummary(request)).rejects.toThrow("llm_reference_invalid");
    await expect(prisma.teachingSummaryCache.count()).resolves.toBe(0);
  });

  it("uses actual communication time and limits model context to confirmed useful records", async () => {
    await prisma.communication.create({
      data: {
        studentId: TEST_FIXTURE.students[0].id,
        sessionId: TEST_FIXTURE.sessions[0].id,
        target: "母亲",
        sourceKey: "test-summary-actual-time",
        summary: "[ST反馈上下文｜实际沟通: 2026-06-30T09:00:00+08:00｜类别: parent-concern｜优先级: high] 家长担心近期复习方法不稳定。",
      },
    });
    const context = await buildTeachingSummaryContext(TeachingSummaryRequestSchema.parse({
      scope: { type: "session", sessionCode: TEST_FIXTURE.sessions[0].code },
      includeCommunications: true,
    }));
    const payload = JSON.stringify(context.promptPayload);
    expect(payload).toContain("2026-06-30");
    expect(payload).toContain("家长担心近期复习方法不稳定");

    const disabled = await buildTeachingSummaryContext(TeachingSummaryRequestSchema.parse({
      scope: { type: "session", sessionCode: TEST_FIXTURE.sessions[0].code },
      includeCommunications: false,
    }));
    expect(JSON.stringify(disabled.promptPayload)).not.toContain("家长担心近期复习方法不稳定");
  });
});

describe("teacher observation persistence", () => {
  it("deduplicates sources, preserves state without new evidence and reopens on new evidence", async () => {
    const first = {
      studentId: TEST_FIXTURE.students[0].id,
      kind: "repeated-parent-concern" as const,
      topic: "parent-concern",
      title: "家长持续关注复习节奏",
      evidenceSummary: "两次沟通均提到复习节奏。",
      communicationIds: ["test-communication-1"],
      relatedSessionId: TEST_FIXTURE.sessions[0].id,
    };
    await persistObservationCandidates(prisma, [first], "test-v1");
    const observation = await prisma.teacherObservation.findFirstOrThrow();
    await updateTeacherObservationStatus(observation.id, "handled");

    await persistObservationCandidates(prisma, [first], "test-v1");
    await expect(prisma.teacherObservation.findUnique({ where: { id: observation.id } }))
      .resolves.toMatchObject({ status: "handled" });

    const communication = await prisma.communication.create({
      data: {
        studentId: TEST_FIXTURE.students[0].id,
        sessionId: TEST_FIXTURE.sessions[1].id,
        target: "母亲",
        sourceKey: "test-summary-new-evidence",
        summary: "再次担心近期复习节奏。",
      },
    });
    await persistObservationCandidates(prisma, [{
      ...first,
      communicationIds: ["test-communication-1", communication.id],
    }], "test-v1");
    await expect(prisma.teacherObservation.findUnique({
      where: { id: observation.id },
      include: { sources: true },
    })).resolves.toMatchObject({ status: "new", sources: [{}, {}] });
    await expect(prisma.systemLog.findFirst({
      where: { action: "teacher_observation.reopened", targetId: observation.id },
    })).resolves.toBeTruthy();
  });
});
