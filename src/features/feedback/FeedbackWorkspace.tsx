"use client";

import { Button, PageHeader, StatusBanner } from "@/components/ui";
import Link from "next/link";
import { FeedbackWorkflow } from "./FeedbackWorkflow";
import { FeedbackBatchPanel } from "./FeedbackBatchPanel";
import type { FeedbackStep } from "./types";
import { useFeedbackWorkspace } from "./useFeedbackWorkspace";

export default function FeedbackWorkspace({ initialStep }: { initialStep?: FeedbackStep }) {
  const workspace = useFeedbackWorkspace(initialStep);
  return (
    <main className="feedback-workspace">
      <PageHeader title="课后工作台" description="完整五步流程、逐学生微操和全部高级选项仍保留在这里。" actions={<Link href="/feedback" className="ui-button ui-button--ghost ui-button--md">返回统一课后任务</Link>} />
      {workspace.error && <StatusBanner tone="danger">{workspace.error}</StatusBanner>}
      {workspace.status && <StatusBanner tone="success">{workspace.status}</StatusBanner>}
      {workspace.legacyDraftAvailable && <StatusBanner tone="warning">另有一份旧“课堂录入”草稿仍保留在当前标签页。<Button variant="ghost" uiSize="sm" onClick={workspace.restoreLegacyDraft}>载入旧草稿</Button></StatusBanner>}
      <FeedbackWorkflow workspace={workspace} />
      <FeedbackBatchPanel initialSemesterId={workspace.context.semesterId} />
    </main>
  );
}
