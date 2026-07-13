"use client";

import { Badge, Button, EmptyState, Section, Textarea } from "@/components/ui";
import type { useFeedbackWorkspace } from "./useFeedbackWorkspace";

type Workspace = ReturnType<typeof useFeedbackWorkspace>;

export function FeedbackGenerationPanel({ workspace }: { workspace: Workspace }) {
  return (
    <Section title="反馈生成与导出" description="生成后可逐条修改，导出使用最终文本。" actions={<><Button onClick={() => void workspace.generate()} disabled={!workspace.canGenerate}>{workspace.generating ? `生成中 ${workspace.feedbackDone}/${workspace.feedbackTotal}` : "批量生成"}</Button><Button variant="secondary" onClick={() => void workspace.exportFeedback()} disabled={workspace.exporting || !workspace.feedbackCards.length}>{workspace.exporting ? "导出中…" : "导出课后反馈表"}</Button></>}>
      <div className="feedback-generation">
        {!workspace.feedbackCards.length ? <EmptyState title="尚未生成反馈" description="选择课次并生成后，每名学生的反馈会显示在这里。" /> : workspace.feedbackCards.map((card) => {
          const context = workspace.contextByStudent.get(card.id);
          const labels = context?.labels.length ? context.labels : card.labels;
          return <article key={card.id} className="feedback-card">
            <header><strong>{card.name}</strong><div>{labels.map((label) => <Badge key={label} tone="info">{label}</Badge>)}</div></header>
            {context && <p className="feedback-card__context">{context.preview.today.slice(0, 2).join("；")}{context.preview.communications.length ? `；${context.preview.communications[0]}` : ""}</p>}
            <Textarea aria-label={`${card.name}反馈`} value={card.feedback} onChange={(event) => workspace.updateFeedback(card.id, event.target.value)} rows={5} />
            <footer><Button variant="ghost" uiSize="sm" onClick={() => void navigator.clipboard?.writeText(card.feedback)}>复制</Button><Button variant="secondary" uiSize="sm" onClick={() => void workspace.regenerateOne(card.id)} disabled={workspace.regeneratingId === card.id}>{workspace.regeneratingId === card.id ? "生成中…" : "单独重写"}</Button></footer>
          </article>;
        })}
      </div>
    </Section>
  );
}
