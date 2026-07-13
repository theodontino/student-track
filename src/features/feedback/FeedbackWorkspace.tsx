"use client";

import FeedbackContextPreview from "@/components/FeedbackContextPreview";
import WorkHistoryButton from "@/components/WorkHistoryButton";
import WeComWorkflowPanel from "@/components/wecom/WeComWorkflowPanel";
import { PageHeader, StatusBanner } from "@/components/ui";
import { ClassroomReviewComposer } from "./ClassroomReviewComposer";
import { DraftConfirmationPanel } from "./DraftConfirmationPanel";
import { FeedbackContextSection } from "./FeedbackContextSection";
import { FeedbackGenerationPanel } from "./FeedbackGenerationPanel";
import { isLegacyFeedbackState } from "./history-adapters";
import { SingleFeedbackPanel } from "./SingleFeedbackPanel";
import type { FeedbackHistoryState } from "./types";
import { useFeedbackWorkspace } from "./useFeedbackWorkspace";

const FEEDBACK_HISTORY_MODULES = ["feedback", "report"] as const;
function isFeedbackHistoryState(value: unknown): value is FeedbackHistoryState { return isLegacyFeedbackState(value); }

export default function FeedbackWorkspace() {
  const workspace = useFeedbackWorkspace();
  return (
    <main className="feedback-workspace">
      <PageHeader title="课后反馈工作台" description="选择课次、准备上下文、确认课堂记录，再生成和导出家长反馈。" actions={<WorkHistoryButton<FeedbackHistoryState> modules={FEEDBACK_HISTORY_MODULES} accept={isFeedbackHistoryState} onRestore={workspace.restoreHistory} />} />
      <FeedbackContextSection workspace={workspace} />
      {workspace.error && <StatusBanner tone="danger">{workspace.error}</StatusBanner>}
      {workspace.status && <StatusBanner tone="success">{workspace.status}</StatusBanner>}

      <div className="feedback-workspace-grid">
        <div className="feedback-preparation-column">
          <WeComWorkflowPanel title="家校沟通准备" description="同步、提取、预览并导入会影响本次反馈的家校沟通。" onApplied={workspace.markContextChanged} />
          <FeedbackContextPreview students={workspace.contextStudents} loading={workspace.contextLoading} error={workspace.contextError} />
        </div>
        <div className="feedback-draft-column">
          <ClassroomReviewComposer workspace={workspace} />
          <DraftConfirmationPanel workspace={workspace} />
        </div>
        <FeedbackGenerationPanel workspace={workspace} />
      </div>
      <SingleFeedbackPanel workspace={workspace} />
    </main>
  );
}
