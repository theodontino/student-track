"use client";

import Link from "next/link";
import FeedbackContextPreview from "@/components/FeedbackContextPreview";
import { AiWorkflowStatus } from "@/features/ai-workflow";
import { ClassroomReviewComposer } from "./ClassroomReviewComposer";
import { DraftConfirmationPanel } from "./DraftConfirmationPanel";
import { FeedbackContextSection } from "./FeedbackContextSection";
import { FeedbackGenerationPanel } from "./FeedbackGenerationPanel";
import { FeedbackMaterialsPanel } from "./FeedbackMaterialsPanel";
import type { FeedbackStep } from "./types";
import type { useFeedbackWorkspace } from "./useFeedbackWorkspace";

type Workspace = ReturnType<typeof useFeedbackWorkspace>;
const steps: Array<{ id: FeedbackStep; label: string; short: string }> = [
  { id: "prepare", label: "选择课次与准备材料", short: "准备" },
  { id: "extract", label: "录入与提取课堂记录", short: "录入" },
  { id: "review", label: "复核并确认", short: "复核" },
  { id: "generate", label: "生成反馈", short: "生成" },
  { id: "export", label: "编辑与导出", short: "导出" },
];

export function FeedbackWorkflow({ workspace }: { workspace: Workspace }) {
  const index = steps.findIndex((step) => step.id === workspace.activeStep);
  return <div className="feedback-flow">
    <nav className="feedback-stepper" aria-label="反馈工作流步骤">{steps.map((step, stepIndex) => <button type="button" key={step.id} aria-current={step.id === workspace.activeStep ? "step" : undefined} className={step.id === workspace.activeStep ? "is-active" : stepIndex < index ? "is-complete" : ""} onClick={() => workspace.setActiveStep(step.id)}><span>{stepIndex + 1}</span><strong>{step.short}</strong><small>{step.label}</small></button>)}</nav>
    <div key={workspace.activeStep} className="feedback-stage">
      {workspace.activeStep === "prepare" && <><FeedbackContextSection workspace={workspace} /><FeedbackMaterialsPanel workspace={workspace} /><div className="feedback-integration-note"><span>企微家校沟通由独立工作区统一同步、复核和导入。</span><Link href="/wecom">前往企微家校</Link></div><FeedbackContextPreview students={workspace.contextStudents} loading={workspace.contextLoading} error={workspace.contextError} /></>}
      {workspace.activeStep === "extract" && <div className="feedback-stage-split"><ClassroomReviewComposer workspace={workspace} /><AiWorkflowStatus state={workspace.workflow} /></div>}
      {workspace.activeStep === "review" && <DraftConfirmationPanel workspace={workspace} />}
      {workspace.activeStep === "generate" && <><AiWorkflowStatus state={workspace.workflow} /><FeedbackGenerationPanel workspace={workspace} mode="generate" /></>}
      {workspace.activeStep === "export" && <><AiWorkflowStatus state={workspace.workflow} /><FeedbackGenerationPanel workspace={workspace} mode="export" /></>}
    </div>
  </div>;
}
