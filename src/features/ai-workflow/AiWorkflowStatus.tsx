import { Badge } from "@/components/ui";
import type { AiWorkflowPhase, AiWorkflowState } from "./workflow-machine";

const DEFAULT_STEPS: Array<{ phase: AiWorkflowPhase; label: string }> = [
  { phase: "validating", label: "检查" },
  { phase: "generating", label: "AI 处理" },
  { phase: "reviewing", label: "人工复核" },
  { phase: "saving", label: "保存" },
];

const ORDER: Record<AiWorkflowPhase, number> = {
  idle: -1,
  validating: 0,
  generating: 1,
  reviewing: 2,
  saving: 3,
  completed: 4,
  failed: -1,
  cancelled: -1,
};

export function AiWorkflowStatus({ state, steps = DEFAULT_STEPS }: {
  state: AiWorkflowState;
  steps?: Array<{ phase: AiWorkflowPhase; label: string }>;
}) {
  if (state.phase === "idle") return null;
  const activeOrder = state.phase === "failed" ? ORDER[state.retryPhase] : ORDER[state.phase];
  const tone = state.phase === "failed" ? "danger" : state.phase === "completed" ? "success" : state.phase === "cancelled" ? "warning" : "info";
  return (
    <section className={`ai-workflow-status is-${state.phase}`} aria-live="polite">
      <div className="ai-workflow-status__copy">
        <Badge tone={tone}>{state.phase === "failed" ? "需要处理" : state.phase === "completed" ? "已完成" : state.phase === "cancelled" ? "已取消" : "进行中"}</Badge>
        <div><strong>{state.operation}</strong><p>{state.message}</p></div>
      </div>
      <ol aria-label="任务进度">
        {steps.map((step, index) => {
          const complete = state.phase === "completed" || index < activeOrder;
          const current = index === activeOrder && state.phase !== "completed";
          return <li key={`${step.phase}-${step.label}`} className={complete ? "is-complete" : current ? "is-current" : ""}><span>{complete ? "✓" : index + 1}</span><small>{step.label}</small></li>;
        })}
      </ol>
      {state.phase === "generating" && state.progress !== null && <div className="ai-workflow-status__progress" aria-label={`完成 ${Math.round(state.progress * 100)}%`}><span style={{ width: `${state.progress * 100}%` }} /></div>}
      {state.phase === "failed" && <p className="ai-workflow-status__error">{state.error}</p>}
    </section>
  );
}
