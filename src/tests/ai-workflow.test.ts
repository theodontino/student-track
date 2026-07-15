import { describe, expect, it } from "vitest";
import {
  aiWorkflowReducer,
  INITIAL_AI_WORKFLOW_STATE,
  isAiWorkflowState,
  recoverAiWorkflowState,
} from "@/features/ai-workflow";

const T0 = "2026-07-15T01:00:00.000Z";
const T1 = "2026-07-15T01:00:01.000Z";

describe("AI workflow machine", () => {
  it("runs through the guarded happy path", () => {
    const validating = aiWorkflowReducer(INITIAL_AI_WORKFLOW_STATE, { type: "start", operation: "解析课堂记录", now: T0 });
    expect(validating.phase).toBe("validating");
    const generating = aiWorkflowReducer(validating, { type: "transition", phase: "generating", now: T1 });
    const reviewing = aiWorkflowReducer(generating, { type: "transition", phase: "reviewing", message: "请人工复核", now: T1 });
    const saving = aiWorkflowReducer(reviewing, { type: "transition", phase: "saving", now: T1 });
    const completed = aiWorkflowReducer(saving, { type: "transition", phase: "completed", now: T1 });
    expect(completed).toMatchObject({ phase: "completed", operation: "解析课堂记录", completedAt: T1 });
  });

  it("rejects an unsafe backwards transition", () => {
    const validating = aiWorkflowReducer(INITIAL_AI_WORKFLOW_STATE, { type: "start", operation: "任务", now: T0 });
    const generating = aiWorkflowReducer(validating, { type: "transition", phase: "generating", now: T1 });
    expect(aiWorkflowReducer(generating, { type: "transition", phase: "validating", now: T1 })).toBe(generating);
  });

  it("clamps progress and preserves a retry phase on failure", () => {
    const validating = aiWorkflowReducer(INITIAL_AI_WORKFLOW_STATE, { type: "start", operation: "生成反馈", now: T0 });
    const generating = aiWorkflowReducer(validating, { type: "transition", phase: "generating", now: T1 });
    const progressed = aiWorkflowReducer(generating, { type: "progress", progress: 2, now: T1 });
    expect(progressed).toMatchObject({ phase: "generating", progress: 1 });
    const failed = aiWorkflowReducer(progressed, { type: "fail", error: "连接中断", now: T1 });
    expect(failed).toMatchObject({ phase: "failed", retryPhase: "generating", error: "连接中断" });
  });

  it("recovers persisted active work as a retryable failure", () => {
    const active = aiWorkflowReducer(INITIAL_AI_WORKFLOW_STATE, { type: "start", operation: "解析", now: T0 });
    expect(recoverAiWorkflowState(active, T1)).toMatchObject({ phase: "failed", retryPhase: "validating" });
  });

  it("keeps safe task context when a running task is cancelled", () => {
    const validating = aiWorkflowReducer(INITIAL_AI_WORKFLOW_STATE, { type: "start", operation: "生成反馈", now: T0 });
    const generating = aiWorkflowReducer(validating, { type: "transition", phase: "generating", now: T1 });
    expect(aiWorkflowReducer(generating, { type: "cancel", message: "教师已取消", now: T1 })).toMatchObject({
      phase: "cancelled",
      operation: "生成反馈",
      message: "教师已取消",
      cancelledAt: T1,
    });
  });

  it("accepts only serializable workflow shapes", () => {
    expect(isAiWorkflowState(INITIAL_AI_WORKFLOW_STATE)).toBe(true);
    expect(isAiWorkflowState({ phase: "generating", operation: "任务" })).toBe(false);
  });
});
