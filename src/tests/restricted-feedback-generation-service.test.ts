import { describe, expect, it, vi } from "vitest";
import type { FeedbackEvidenceBundle } from "@/lib/feedback-plan";
import {
  buildRestrictedWriterInput,
  compileRestrictedComposition,
  generateRestrictedFeedback,
  validateFeedbackStrategy,
  type FeedbackStrategyV1,
  type RestrictedFeedbackCheckpointV1,
} from "@/services/restricted-feedback-generation-service";

function clientWith(...responses: unknown[]) {
  const create = vi.fn();
  for (const response of responses) {
    create.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify(response) } }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    });
  }
  return { client: { chat: { completions: { create } } } as any, create };
}

const evidence: FeedbackEvidenceBundle = {
  version: 2,
  planType: "event_micro",
  studentId: "student-1",
  teachingEvidence: [{
    id: "fact-1",
    kind: "fact",
    content: "课堂独立完成了基础题",
    sourceRefs: [{ type: "fact", id: "source-1" }],
    confirmed: true,
  }],
  assessmentEvidence: [],
  communicationContext: [{
    id: "communication-secret",
    kind: "teacher_judgment",
    content: "只供老师判断，不得下发给成文模型",
    sourceRefs: [{ type: "communication", id: "source-secret" }],
    confirmed: true,
  }],
  teachingBackground: ["课程内部背景，不直接下发给成文模型"],
  historySnapshot: null,
  executionConstraints: {
    existingTaskIds: [],
    fixedArrangementRefs: [],
    teacherInterventionPresent: false,
  },
  sourceRefs: [{ type: "student", id: "student-1" }],
  sourceFingerprint: "restricted-feedback-test-fingerprint",
};

function strategy(overrides: Partial<FeedbackStrategyV1> = {}): FeedbackStrategyV1 {
  return {
    version: 1,
    mainFocus: "说明本次课堂表现",
    closureType: "positive_recognition",
    points: [{
      id: "P1",
      moduleKey: "observed_moment",
      kind: "fact",
      content: "Planner 自由改写，不得进入 Writer",
      evidenceRefs: ["fact-1"],
      confidence: "high",
    }],
    contextOnly: [{
      content: "只供 Planner 判断",
      reason: "不适合对家长披露",
      evidenceRefs: ["communication-secret"],
    }],
    omit: [],
    communicationIntent: "Planner 自由沟通意图，不得进入 Writer",
    needParentAction: false,
    parentAction: null,
    unresolved: [],
    ...overrides,
  };
}

function writerOutput() {
  return {
    version: 1,
    modules: [{ key: "observed_moment", content: "课堂独立完成了基础题。", disclosureIds: ["D1"] }],
    coverage: [{ disclosureId: "D1", statement: "课堂独立完成了基础题" }],
    parentAction: null,
    draftFeedback: "今天孩子课堂独立完成了基础题。",
  };
}

const generationInput = {
  studentName: "合成学生",
  planType: "event_micro" as const,
  outputRequirement: "不得出现这段原始要求",
  evidenceBundle: evidence,
  style: "gentle" as const,
  length: "standard" as const,
  generationPreferences: {
    closureType: "positive_recognition" as const,
    moduleKeys: ["observed_moment", "teacher_interpretation"],
  },
  plannerModel: "planner-model",
  writerModel: "writer-model",
};

function buildWriterInput(currentStrategy = strategy(), overrides: {
  evidenceBundle?: FeedbackEvidenceBundle;
  planType?: "class_update" | "event_micro";
  outputRequirement?: string;
  forbiddenStudentNames?: string[];
} = {}) {
  return buildRestrictedWriterInput({
    studentName: overrides.planType === "class_update" ? "班级整体" : generationInput.studentName,
    planType: overrides.planType ?? generationInput.planType,
    outputRequirement: overrides.outputRequirement ?? generationInput.outputRequirement,
    evidenceBundle: overrides.evidenceBundle ?? evidence,
    style: generationInput.style,
    length: generationInput.length,
    strategy: currentStrategy,
    forbiddenStudentNames: overrides.forbiddenStudentNames,
  });
}

function validate(currentStrategy: FeedbackStrategyV1, overrides: {
  outputRequirement?: string;
  planType?: "class_update" | "event_micro";
  generationPreferences?: typeof generationInput.generationPreferences;
} = {}) {
  return validateFeedbackStrategy({
    strategy: currentStrategy,
    evidenceBundle: evidence,
    outputRequirement: overrides.outputRequirement ?? generationInput.outputRequirement,
    planType: overrides.planType ?? generationInput.planType,
    generationPreferences: overrides.generationPreferences ?? generationInput.generationPreferences,
  });
}

describe("restricted feedback generation", () => {
  it("只从服务端来源编译 Writer 披露，不信任 Planner 自由文本", () => {
    const writerInput = buildWriterInput();
    const serialized = JSON.stringify(writerInput);

    expect(writerInput.disclosures[0].content).toBe("课堂独立完成了基础题");
    expect(writerInput.plan.communicationIntent).toBe("向家长清楚说明当前学生已确认的学习情况，只使用本次披露内容。");
    expect(serialized).not.toContain("Planner 自由改写");
    expect(serialized).not.toContain("Planner 自由沟通意图");
    expect(serialized).not.toContain("fact-1");
    expect(serialized).not.toContain("communication-secret");
    expect(serialized).not.toContain("只供 Planner 判断");
    expect(serialized).not.toContain("课程内部背景");
    expect(serialized).not.toContain(generationInput.outputRequirement);
  });

  it("只在策略显式引用时下发课程背景或教师要求", () => {
    const backgroundStrategy = strategy({
      points: [{ ...strategy().points[0], kind: "teaching_background", evidenceRefs: ["teaching-background:1"] }],
    });
    const requirementStrategy = strategy({
      points: [{ ...strategy().points[0], kind: "teacher_instruction", evidenceRefs: ["teacher-output-requirement"] }],
    });

    expect(buildWriterInput(backgroundStrategy).disclosures[0]).toEqual(expect.objectContaining({
      kind: "teaching_background",
      content: "课程内部背景,不直接下发给成文模型",
    }));
    expect(buildWriterInput(requirementStrategy).disclosures[0]).toEqual(expect.objectContaining({
      kind: "teacher_instruction",
      content: generationInput.outputRequirement,
    }));
  });

  it("不给 Writer 下发 Planner 的家长动作 brief", () => {
    const parentActionStrategy = strategy({
      closureType: "home_cooperation",
      points: [{
        ...strategy().points[0],
        moduleKey: "parent_action",
        kind: "teacher_instruction",
        evidenceRefs: ["teacher-output-requirement"],
      }],
      communicationIntent: "私有沟通事实",
      needParentAction: true,
      parentAction: {
        type: "remind",
        actionBrief: "Planner 私有动作说明",
        successCriteriaBrief: "Planner 私有成功标准",
        notNeededBrief: "Planner 私有取消条件",
        pointIds: ["P1"],
      },
    });

    const writerInput = buildWriterInput(parentActionStrategy, { outputRequirement: "请家长提醒携带练习册" });
    expect(writerInput.parentAction).toEqual({ type: "remind", disclosureIds: ["D1"] });
    expect(JSON.stringify(writerInput)).not.toContain("Planner 私有");
    expect(JSON.stringify(writerInput)).not.toContain("私有沟通事实");
  });

  it("拒绝未知证据、原始沟通、越权模块和越权结尾", () => {
    expect(() => validate(strategy({
      points: [{ ...strategy().points[0], evidenceRefs: ["missing-fact"] }],
    }))).toThrow("未知或未确认证据");

    expect(() => validate(strategy({
      points: [{ ...strategy().points[0], evidenceRefs: ["communication-secret"] }],
      contextOnly: [],
    }))).toThrow("原始沟通内容");

    expect(() => validate(strategy({
      points: [{ ...strategy().points[0], moduleKey: "teacher_intervention" }],
    }))).toThrow("未授权模块");

    expect(() => validate(strategy({ closureType: "continued_observation" }))).toThrow("未授权结尾");
  });

  it("要求 points、contextOnly 与 omit 的来源引用互斥", () => {
    expect(() => validate(strategy({
      contextOnly: [{ content: "重复上下文", reason: "测试", evidenceRefs: ["fact-1"] }],
    }))).toThrow("重复分配证据");

    expect(() => validate(strategy({
      contextOnly: [],
      omit: [{ evidenceRefs: ["fact-1"], reason: "重复省略" }],
    }))).toThrow("重复分配证据");
  });

  it("拒绝编译后 Writer 输入或输出中的禁用学生姓名，包括班级反馈", () => {
    const namedEvidence: FeedbackEvidenceBundle = {
      ...evidence,
      planType: "class_update",
      teachingEvidence: [{ ...evidence.teachingEvidence[0], content: "王小明完成了基础题" }],
    };
    expect(() => buildWriterInput(strategy(), {
      evidenceBundle: namedEvidence,
      planType: "class_update",
      forbiddenStudentNames: ["王小明"],
    })).toThrow("未授权学生姓名");

    const currentStrategy = strategy();
    const writerInput = buildWriterInput(currentStrategy);
    expect(() => compileRestrictedComposition({
      strategy: currentStrategy,
      writerInput,
      forbiddenStudentNames: ["王小明"],
      writerOutput: {
        ...writerOutput(),
        modules: [{ key: "observed_moment", content: "王小明课堂独立完成了基础题。", disclosureIds: ["D1"] }],
        draftFeedback: "王小明课堂独立完成了基础题。",
      },
    })).toThrow("未授权学生姓名");
  });

  it("把 Writer 的披露覆盖确定性映射回现有 Composition", () => {
    const currentStrategy = strategy();
    const writerInput = buildWriterInput(currentStrategy);
    const result = compileRestrictedComposition({
      strategy: currentStrategy,
      writerInput,
      writerOutput: writerOutput(),
    });

    expect(result.composition.modules).toEqual([expect.objectContaining({
      key: "observed_moment",
      evidenceRefs: ["fact-1"],
    })]);
    expect(result.composition.evidenceCoverage).toEqual([{
      evidenceId: "fact-1",
      statement: "课堂独立完成了基础题",
    }]);
    expect(() => compileRestrictedComposition({
      strategy: currentStrategy,
      writerInput,
      writerOutput: {
        ...writerOutput(),
        modules: [{ key: "teacher_intervention", content: "越权内容", disclosureIds: ["D1"] }],
      },
    })).toThrow("未披露模块");
  });

  it("要求模块内容出现在正文，且每项模块披露恰好有一条有效 coverage", () => {
    const currentStrategy = strategy();
    const writerInput = buildWriterInput(currentStrategy);

    expect(() => compileRestrictedComposition({
      strategy: currentStrategy,
      writerInput,
      writerOutput: { ...writerOutput(), coverage: [] },
    })).toThrow("缺少披露内容的覆盖声明");

    expect(() => compileRestrictedComposition({
      strategy: currentStrategy,
      writerInput,
      writerOutput: { ...writerOutput(), coverage: [writerOutput().coverage[0], writerOutput().coverage[0]] },
    })).toThrow("重复返回覆盖声明");

    expect(() => compileRestrictedComposition({
      strategy: currentStrategy,
      writerInput,
      writerOutput: {
        ...writerOutput(),
        modules: [{ ...writerOutput().modules[0], disclosureIds: ["D1", "D1"] }],
      },
    })).toThrow("重复使用披露内容");

    expect(() => compileRestrictedComposition({
      strategy: currentStrategy,
      writerInput,
      writerOutput: {
        ...writerOutput(),
        modules: [{ ...writerOutput().modules[0], content: "正文里没有的模块句子" }],
      },
    })).toThrow("模块正文未出现在最终正文中");
  });

  it("拒绝没有被模块采用的闲置 coverage", () => {
    const currentStrategy = strategy({
      points: [
        strategy().points[0],
        {
          id: "P2",
          moduleKey: "teacher_interpretation",
          kind: "teaching_background",
          content: "Planner 背景摘要",
          evidenceRefs: ["teaching-background:1"],
        },
      ],
    });
    const writerInput = buildWriterInput(currentStrategy);
    expect(() => compileRestrictedComposition({
      strategy: currentStrategy,
      writerInput,
      writerOutput: {
        ...writerOutput(),
        coverage: [
          writerOutput().coverage[0],
          { disclosureId: "D2", statement: "课程内部背景" },
        ],
        draftFeedback: "今天孩子课堂独立完成了基础题。课程内部背景。",
      },
    })).toThrow("未使用内容的覆盖声明");
  });

  it("Planner 校验失败后修复，并在 Writer 调用前保存带真实 trace 的检查点", async () => {
    const invalid = strategy({
      points: [{ ...strategy().points[0], evidenceRefs: ["missing-fact"] }],
    });
    const planner = clientWith(invalid, strategy());
    const writer = clientWith();
    const events: string[] = [];
    let savedCheckpoint: RestrictedFeedbackCheckpointV1 | null = null;
    writer.create.mockImplementationOnce(async () => {
      events.push("writer");
      return {
        choices: [{ message: { content: JSON.stringify(writerOutput()) } }],
        usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
      };
    });

    const result = await generateRestrictedFeedback({
      ...generationInput,
      plannerClient: planner.client,
      writerClient: writer.client,
      onCheckpoint: (checkpoint) => {
        savedCheckpoint = checkpoint;
        events.push("checkpoint");
      },
    });

    expect(planner.create).toHaveBeenCalledTimes(2);
    expect(writer.create).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["checkpoint", "writer"]);
    expect(result.planner.attempts).toBe(2);
    expect(result.planner.usage.totalTokens).toBe(40);
    expect(savedCheckpoint).toEqual(expect.objectContaining({
      plannerTrace: expect.objectContaining({
        model: "planner-model",
        attempts: 2,
        usage: expect.objectContaining({ totalTokens: 40 }),
      }),
    }));
    const writerPrompt = writer.create.mock.calls[0][0].messages[0].content as string;
    expect(writerPrompt).not.toContain("communication-secret");
    expect(writerPrompt).not.toContain("只供老师判断");
    expect(writerPrompt).not.toContain(generationInput.outputRequirement);
    expect(writerPrompt).not.toContain("Planner 自由改写");
  });

  it("从检查点重试时复用 Planner 的真实 usage、耗时和模型记录", async () => {
    const currentStrategy = strategy();
    const checkpoint: RestrictedFeedbackCheckpointV1 = {
      version: 1,
      strategy: currentStrategy,
      writerInput: buildWriterInput(currentStrategy),
      plannerTrace: {
        model: "原始-planner-model",
        attempts: 2,
        durationMs: 87,
        usage: { inputTokens: 24, outputTokens: 16, reasoningTokens: null, totalTokens: 40 },
      },
    };
    const planner = clientWith();
    const writer = clientWith(writerOutput());

    const result = await generateRestrictedFeedback({
      ...generationInput,
      plannerClient: planner.client,
      writerClient: writer.client,
      checkpoint,
    });

    expect(planner.create).not.toHaveBeenCalled();
    expect(writer.create).toHaveBeenCalledOnce();
    expect(result.planner).toEqual({
      ...checkpoint.plannerTrace,
      reusedCheckpoint: true,
    });
  });
});
