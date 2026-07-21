"use client";

import { Badge, Button, EmptyState, Section, StatusBanner, Textarea } from "@/components/ui";
import type { useFeedbackWorkspace } from "./useFeedbackWorkspace";

type Workspace = ReturnType<typeof useFeedbackWorkspace>;

const reviewLabels = {
  passed: { label: "AI 审核通过", tone: "success" as const },
  revised: { label: "AI 已修订", tone: "info" as const },
  needs_review: { label: "需要人工确认", tone: "warning" as const },
  edited: { label: "教师已修改", tone: "success" as const },
};

export function FeedbackGenerationPanel({ workspace, mode = "export" }: { workspace: Workspace; mode?: "generate" | "export" }) {
  return (
    <Section title={mode === "generate" ? "生成班级反馈" : "编辑与导出"} description={mode === "generate" ? "分析模型先结合本次表现、近期趋势和历史生成内部草稿，成稿模型再复核并改写成家长话术。" : "逐条检查和修改；待人工确认项处理完后才能导出。"} actions={<>{mode === "generate" && <Button onClick={() => void workspace.generate()} disabled={!workspace.canGenerate}>{workspace.generating ? `${workspace.feedbackPhase === "review" ? "成稿与审核" : "分析"}中 ${workspace.feedbackDone}/${workspace.feedbackTotal}` : "分析并生成反馈"}</Button>}{mode === "export" && <><Button variant="secondary" onClick={workspace.prepareRegeneration}>重新生成</Button><Button onClick={() => void workspace.exportFeedback()} disabled={workspace.exporting || !workspace.feedbackCards.length || workspace.feedbackReviewBlockerCount > 0}>{workspace.exporting ? "导出中…" : "导出课后反馈表"}</Button></>}</>}>
      <div className="feedback-generation">
        {workspace.feedbackReviewBlockerCount > 0 && <StatusBanner tone="warning">有 {workspace.feedbackReviewBlockerCount} 条反馈需要人工确认；编辑对应文本后即可解除导出限制。</StatusBanner>}
        {!workspace.feedbackCards.length ? <EmptyState title={workspace.generating ? "正在生成反馈" : "尚未生成反馈"} description={workspace.generating ? `${workspace.feedbackPhase === "review" ? "成稿与审核" : "分析"} ${workspace.feedbackDone}/${workspace.feedbackTotal || "…"}，完成后会自动进入编辑与导出。` : "选择课次并生成后，每名学生的反馈会显示在这里。"} /> : workspace.feedbackCards.map((card) => {
          const context = workspace.contextByStudent.get(card.id);
          const labels = context?.labels.length ? context.labels : card.labels;
          const review = card.reviewStatus ? reviewLabels[card.reviewStatus] : null;
          return <article key={card.id} className="feedback-card">
            <header><strong>{card.name}</strong><div>{review && <Badge tone={review.tone}>{review.label}</Badge>}{labels.map((label) => <Badge key={label} tone="info">{label}</Badge>)}</div></header>
            {context && <p className="feedback-card__context">{context.preview.today.slice(0, 2).join("；")}{context.preview.communications.length ? `；${context.preview.communications[0]}` : ""}</p>}
            {card.reviewIssues?.length ? <ul className="feedback-card__review-issues">{card.reviewIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul> : null}
            {card.draftFeedback && card.draftFeedback !== card.feedback && <details className="feedback-card__draft"><summary>查看内部分析草稿</summary><p>{card.draftFeedback}</p></details>}
            <Textarea aria-label={`${card.name}反馈`} value={card.feedback} onChange={(event) => workspace.updateFeedback(card.id, event.target.value)} rows={5} />
            <footer><Button variant="ghost" uiSize="sm" onClick={() => void navigator.clipboard?.writeText(card.feedback)}>复制</Button><Button variant="secondary" uiSize="sm" onClick={() => void workspace.regenerateOne(card.id)} disabled={workspace.regeneratingId === card.id}>{workspace.regeneratingId === card.id ? "生成中…" : "单独重写"}</Button></footer>
          </article>;
        })}
      </div>
    </Section>
  );
}
