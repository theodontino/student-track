"use client";

import { Badge, Button, EmptyState, ErrorState, FilterBar, LoadingState, Select, StatusBanner } from "@/components/ui";
import { DraftReviewEditor } from "./draft-components";
import { useReviewWorkspace } from "./useReviewWorkspace";
import { reviewedStudentCount, type ReviewFilterStatus } from "./workspace-state";

const FILTERS: Array<{ value: ReviewFilterStatus; label: string }> = [
  { value: "pending", label: "待复核" },
  { value: "confirmed", label: "已确认" },
  { value: "rejected", label: "已放弃" },
];

function emptyTitle(status: ReviewFilterStatus) {
  if (status === "pending") return "没有待复核的记录";
  if (status === "confirmed") return "没有已确认的记录";
  return "没有已放弃的记录";
}

export default function ReviewStep() {
  const workspace = useReviewWorkspace();
  return (
    <div className="entry-review-workspace">
      <div className="entry-step-heading"><div><h2>复核中心</h2><p>核对系统生成的草案，只有确认后才会写入数据库。</p></div></div>
      <FilterBar className="entry-review-filters">
        <div role="group" aria-label="草案状态">
          {FILTERS.map((filter) => <Button key={filter.value} uiSize="sm" variant={workspace.filterStatus === filter.value ? "primary" : "secondary"} onClick={() => workspace.setFilterStatus(filter.value)}>{filter.label}</Button>)}
        </div>
        <label><span>班级</span><Select aria-label="班级" value={workspace.filterClass} onChange={(event) => workspace.setFilterClass(event.target.value)}><option value="">全部</option>{workspace.classes.map((className) => <option key={className} value={className}>{className}</option>)}</Select></label>
      </FilterBar>

      {workspace.actionMessage && <StatusBanner tone={workspace.actionMessage.tone}>{workspace.actionMessage.text}</StatusBanner>}
      {workspace.loading ? <LoadingState label="正在加载草案…" /> : workspace.loadError ? <ErrorState message={workspace.loadError} action={<Button onClick={() => void workspace.fetchDrafts()}>重试</Button>} /> : workspace.drafts.length === 0 ? <EmptyState title={emptyTitle(workspace.filterStatus)} description="切换状态或班级可以查看其他草案。" /> : (
        <div className="entry-review-list">
          {workspace.drafts.map((draft) => {
            const expanded = workspace.expandedId === draft.id;
            const current = workspace.edits[draft.id] ?? draft.parsedResult;
            const attentionCount = reviewedStudentCount(draft);
            return (
              <article key={draft.id} className="entry-review-item">
                <button type="button" className="entry-review-item__summary" aria-expanded={expanded} onClick={() => workspace.toggleDraft(draft)}>
                  <span className="entry-review-item__copy"><strong>{draft.rawText}</strong><small>{new Date(draft.createdAt).toLocaleString("zh-CN")} · {draft.parsedResult.students.length} 名学生{draft.sessionCode ? ` · ${draft.sessionCode}` : ""}</small></span>
                  <span className="entry-review-item__status">{draft.reviewResult?.is_valid ? <Badge tone="success">自审通过</Badge> : draft.reviewResult ? <Badge tone="warning">{draft.reviewResult.issues.length} 个问题 · {attentionCount} 人需关注</Badge> : <Badge>无自审结果</Badge>}<span>{expanded ? "收起" : "展开"}</span></span>
                </button>
                {expanded && <DraftReviewEditor
                  result={current}
                  review={draft.reviewResult}
                  processing={workspace.processingId === draft.id}
                  onScoreChange={(studentIndex, dimension, value) => workspace.updateScore(draft.id, studentIndex, dimension, value)}
                  onAttendanceChange={(studentIndex, present) => workspace.updateAttendance(draft.id, studentIndex, present)}
                  onRemoveEvent={(studentIndex, eventIndex) => workspace.removeEvent(draft.id, studentIndex, eventIndex)}
                  onReject={() => void workspace.handleAction(draft.id, "reject")}
                  onConfirm={() => void workspace.handleAction(draft.id, "confirm")}
                />}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
