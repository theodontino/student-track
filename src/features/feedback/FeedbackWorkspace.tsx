"use client";

import WorkHistoryButton from "@/components/WorkHistoryButton";
import { Button, Drawer, PageHeader, StatusBanner } from "@/components/ui";
import { useState } from "react";
import { FeedbackWorkflow } from "./FeedbackWorkflow";
import { isLegacyFeedbackState } from "./history-adapters";
import { SingleFeedbackPanel } from "./SingleFeedbackPanel";
import type { FeedbackHistoryState } from "./types";
import { useFeedbackWorkspace } from "./useFeedbackWorkspace";

const FEEDBACK_HISTORY_MODULES = ["feedback", "report"] as const;
function isFeedbackHistoryState(value: unknown): value is FeedbackHistoryState { return isLegacyFeedbackState(value); }

export default function FeedbackWorkspace() {
  const workspace = useFeedbackWorkspace();
  const [singleOpen, setSingleOpen] = useState(false);
  return (
    <main className="feedback-workspace">
      <PageHeader title="课后反馈工作台" description="选择课次、准备上下文、确认课堂记录，再生成和导出家长反馈。" actions={<><Button variant="secondary" onClick={() => setSingleOpen(true)}>单人反馈</Button><WorkHistoryButton<FeedbackHistoryState> modules={FEEDBACK_HISTORY_MODULES} accept={isFeedbackHistoryState} onRestore={workspace.restoreHistory} /></>} />
      {workspace.error && <StatusBanner tone="danger">{workspace.error}</StatusBanner>}
      {workspace.status && <StatusBanner tone="success">{workspace.status}</StatusBanner>}
      <FeedbackWorkflow workspace={workspace} />
      <Drawer open={singleOpen} title="单人反馈" size="wide" onClose={() => setSingleOpen(false)}><div className="feedback-single-drawer"><SingleFeedbackPanel workspace={workspace} /></div></Drawer>
    </main>
  );
}
