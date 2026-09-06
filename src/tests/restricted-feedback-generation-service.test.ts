import { describe, expect, it, vi } from "vitest";
import type { FeedbackEvidenceBundle } from "@/lib/feedback-plan";
import {
  buildStudentContentBriefWriterInput,
  buildRestrictedWriterInput,
  compileRestrictedComposition,
  generateStudentContentBriefFeedback,
  generateRestrictedFeedback,
  RestrictedFeedbackCheckpointV2Schema,
  validateFeedbackStrategy,
  type ContentBrief,
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

function checkpoint(currentStrategy = strategy()): RestrictedFeedbackCheckpointV1 {
  return {
    version: 1,
    strategy: currentStrategy,
    writerInput: buildWriterInput(currentStrategy),
    plannerTrace: {
      model: "planner-model",
      attempts: 1,
      durationMs: 1,
      usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: null, totalTokens: 2 },
    },
  };
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
    expect(result.kind).toBe("validated");
  });

  it("两次协议校验失败时保留最后一份可解析正文，并继续隔离受限输入", async () => {
    const planner = clientWith();
    const writer = clientWith(
      { ...writerOutput(), coverage: [], draftFeedback: "第一版：课堂独立完成了基础题。" },
      { ...writerOutput(), coverage: [], draftFeedback: "第二版：课堂独立完成了基础题。" },
    );

    const result = await generateRestrictedFeedback({
      ...generationInput,
      plannerClient: planner.client,
      writerClient: writer.client,
      checkpoint: checkpoint(),
    });

    expect(result).toMatchObject({
      kind: "blocked_draft",
      writerOutput: null,
      composition: { draftFeedback: "第二版：课堂独立完成了基础题。", modules: [], evidenceCoverage: [] },
      blocker: { code: "restricted_writer_output_invalid" },
      writer: { attempts: 2 },
    });
    const retryPrompt = writer.create.mock.calls[1]![0].messages[0].content as string;
    expect(retryPrompt).not.toContain("communication-secret");
    expect(retryPrompt).not.toContain("只供老师判断");
    expect(retryPrompt).not.toContain(generationInput.outputRequirement);
    expect(retryPrompt).not.toContain("Planner 自由改写");
  });

  it("修复请求失败时仍保留上一轮安全候选，但不从非法 JSON 猜正文", async () => {
    const firstCreate = vi.fn()
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ ...writerOutput(), coverage: [], draftFeedback: "可保留：课堂独立完成了基础题。" }) } }],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      })
      .mockRejectedValueOnce(new Error("repair unavailable"));
    const firstResult = await generateRestrictedFeedback({
      ...generationInput,
      plannerClient: clientWith().client,
      writerClient: { chat: { completions: { create: firstCreate } } } as any,
      checkpoint: checkpoint(),
    });
    expect(firstResult).toMatchObject({
      kind: "blocked_draft",
      composition: { draftFeedback: "可保留：课堂独立完成了基础题。" },
    });

    const invalidCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "not valid json with draftFeedback" } }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    });
    await expect(generateRestrictedFeedback({
      ...generationInput,
      plannerClient: clientWith().client,
      writerClient: { chat: { completions: { create: invalidCreate } } } as any,
      checkpoint: checkpoint(),
    })).rejects.toThrow("未返回合法 JSON");
    expect(invalidCreate).toHaveBeenCalledTimes(2);
  });
});

describe("student restricted ContentBrief generation", () => {
  const lessonMaterial = {
    version: 1 as const,
    groupFeedbackRaw: "",
    assessmentBriefRaw: "",
    lessonTitle: "合成课程",
    classroomContent: [],
    classroomFocus: [],
    classroomExplanation: [],
    homework: [],
    assessmentFocus: [],
    correctionAdvice: [],
    otherNotes: [],
  };
  const largeAssessment = [
    "本次出门测总正确率 62%",
    "同期均值 78%",
    "知识点 A：离子反应",
    "知识点 B：氧化还原",
    "知识点 C：物质的量",
    "第 1 题错误",
    "第 2 题错误",
    "第 3 题错误",
  ].join("；");
  const contentBrief: ContentBrief = {
    mainFocus: "说明本次出门测",
    present: [{ content: "出门测正确率 62%", evidenceRefs: ["assessment-large"] }],
    background: [{ content: "本次练习用于检查离子反应", evidenceRefs: ["fact-1"] }],
    interpretations: [{ content: "离子反应仍需巩固", evidenceRefs: ["assessment-large"], confidence: "high" }],
    contextOnly: [{ content: "同期均值只供判断", reason: "本次不对家长展开" }],
    omit: [{ evidenceRefs: ["communication-secret"], reason: "原始沟通不下发" }],
    communicationIntent: "简短说明表现并保持积极",
    unresolved: ["后续表现待观察"],
  };
  const studentEvidence: FeedbackEvidenceBundle = {
    ...evidence,
    assessmentEvidence: [{
      id: "assessment-large",
      kind: "fact",
      content: largeAssessment,
      sourceRefs: [{ type: "assessment", id: "test-assessment" }],
      confirmed: true,
    }],
  };
  const studentInput = {
    ...generationInput,
    lessonMaterial,
    communicationPreference: null,
    evidenceBundle: studentEvidence,
  };

  it("Writer 只接收 Planner 整理后的 ContentBrief，不接收原始事实和教师要求", async () => {
    const planner = clientWith(contentBrief);
    const writer = clientWith({ feedback: "这次出门测正确率为62%，离子反应还需要继续巩固。" });

    const result = await generateStudentContentBriefFeedback({
      ...studentInput,
      plannerClient: planner.client,
      writerClient: writer.client,
    });

    const plannerPrompt = planner.create.mock.calls[0]![0].messages[0].content as string;
    const writerPrompt = writer.create.mock.calls[0]![0].messages[0].content as string;
    expect(plannerPrompt).toContain(largeAssessment);
    expect(plannerPrompt).toContain(generationInput.outputRequirement);
    expect(writerPrompt).toContain("出门测正确率 62%");
    expect(writerPrompt).toContain("离子反应仍需巩固");
    expect(writerPrompt).not.toContain(largeAssessment);
    expect(writerPrompt).not.toContain("同期均值 78%");
    expect(writerPrompt).not.toContain("知识点 B");
    expect(writerPrompt).not.toContain("第 1 题错误");
    expect(writerPrompt).not.toContain(generationInput.outputRequirement);
    expect(writerPrompt).not.toContain("communication-secret");
    expect(writerPrompt).not.toContain("contextOnly");
    expect(writerPrompt).not.toContain("omit");
    expect(writerPrompt).not.toContain("unresolved");
    expect(result.composition).toMatchObject({
      modules: [],
      evidenceCoverage: [],
      draftFeedback: "这次出门测正确率为62%，离子反应还需要继续巩固。",
    });
  });

  it("Planner 未知 evidenceRef 只修正一次，第二次仍无效则失败", async () => {
    const invalidBrief = {
      ...contentBrief,
      present: [{ content: "不存在的事实", evidenceRefs: ["missing-evidence"] }],
    };
    const planner = clientWith(invalidBrief, invalidBrief);
    const writer = clientWith({ feedback: "不应调用" });

    await expect(generateStudentContentBriefFeedback({
      ...studentInput,
      plannerClient: planner.client,
      writerClient: writer.client,
    })).rejects.toThrow("未知 evidenceRef");
    expect(planner.create).toHaveBeenCalledTimes(2);
    expect(writer.create).not.toHaveBeenCalled();
  });

  it("Writer 返回 JSON 或普通正文时都保留非空 candidate", async () => {
    const checkpoint = RestrictedFeedbackCheckpointV2Schema.parse({
      version: 2,
      contentBrief,
      writerInput: buildStudentContentBriefWriterInput(studentInput as any, contentBrief),
      plannerTrace: {
        model: "planner-model",
        attempts: 1,
        durationMs: 7,
        usage: { inputTokens: 2, outputTokens: 2, reasoningTokens: null, totalTokens: 4 },
      },
    });
    const jsonWriter = clientWith({ feedback: "JSON 正文" });
    const jsonResult = await generateStudentContentBriefFeedback({
      ...studentInput,
      plannerClient: clientWith().client,
      writerClient: jsonWriter.client,
      checkpoint,
    });
    expect(jsonResult.composition.draftFeedback).toBe("JSON 正文");
    expect(jsonResult.planner).toMatchObject({ model: "planner-model", reusedCheckpoint: true });

    const rawCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "普通正文也应保存" } }],
      usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
    });
    const rawResult = await generateStudentContentBriefFeedback({
      ...studentInput,
      plannerClient: clientWith().client,
      writerClient: { chat: { completions: { create: rawCreate } } } as any,
      checkpoint,
    });
    expect(rawResult.composition.draftFeedback).toBe("普通正文也应保存");
  });

  it("Writer 没有任何非空正文时才失败", async () => {
    const planner = clientWith(contentBrief);
    const emptyCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "" } }],
      usage: { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 },
    });
    await expect(generateStudentContentBriefFeedback({
      ...studentInput,
      plannerClient: planner.client,
      writerClient: { chat: { completions: { create: emptyCreate } } } as any,
    })).rejects.toThrow("未返回有效 JSON");
  });
});
