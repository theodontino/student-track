"use client";

import { Badge, Button, Select, Section, Textarea } from "@/components/ui";
import type { useFeedbackWorkspace } from "./useFeedbackWorkspace";

type Workspace = ReturnType<typeof useFeedbackWorkspace>;

export function SingleFeedbackPanel({ workspace }: { workspace: Workspace }) {
  const availableStudents = workspace.students.filter((student) => !workspace.context.className || student.class === workspace.context.className);
  const reviewLabel = workspace.singleReviewStatus === "passed" ? "AI 审核通过"
    : workspace.singleReviewStatus === "revised" ? "AI 已修订"
      : workspace.singleReviewStatus === "needs_review" ? "需要人工确认"
        : workspace.singleReviewStatus === "edited" ? "教师已修改"
          : "";
  return (
    <Section title="单人反馈" description="先结合趋势和历史生成本地内部分析，再复核并改写成家长话术；未选课次时按最近天数汇总。">
      <div className="feedback-single">
        <div className="feedback-single__controls">
          <label><span>学生</span><Select value={workspace.singleStudentId} onChange={(event) => workspace.setSingleStudentId(event.target.value)}><option value="">选择学生</option>{availableStudents.map((student) => <option key={student.id} value={student.id}>{student.name}（{student.class}）</option>)}</Select></label>
          {!workspace.context.sessionCode && <label><span>时间范围</span><Select value={workspace.singleDays} onChange={(event) => workspace.setSingleDays(Number(event.target.value))}><option value={7}>近 7 天</option><option value={14}>近 14 天</option><option value={30}>近 30 天</option></Select></label>}
          <Button onClick={() => void workspace.generateSingleFeedback()} disabled={!workspace.singleStudentId || workspace.singleLoading}>{workspace.singleLoading ? "分析并成稿中…" : "分析并生成"}</Button>
        </div>
        {(workspace.singleFeedback || workspace.singleReviewStatus) && <div className="feedback-single__result">
          {reviewLabel && <Badge tone={workspace.singleReviewStatus === "needs_review" ? "warning" : "success"}>{reviewLabel}</Badge>}
          {workspace.singleReviewIssues.length > 0 && <ul className="feedback-card__review-issues">{workspace.singleReviewIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
          {workspace.singleDraftFeedback && workspace.singleDraftFeedback !== workspace.singleFeedback && <details className="feedback-card__draft"><summary>查看内部分析草稿</summary><p>{workspace.singleDraftFeedback}</p></details>}
          <Textarea aria-label="单人反馈内容" value={workspace.singleFeedback} onChange={(event) => workspace.updateSingleFeedback(event.target.value)} rows={6} />
        </div>}
      </div>
    </Section>
  );
}
