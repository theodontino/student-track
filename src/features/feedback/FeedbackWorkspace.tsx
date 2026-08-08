"use client";

import { Button, PageHeader, StatusBanner } from "@/components/ui";
import { FeedbackWorkflow } from "./FeedbackWorkflow";
import type { FeedbackStep } from "./types";
import { useFeedbackWorkspace } from "./useFeedbackWorkspace";

export default function FeedbackWorkspace({ initialStep }: { initialStep?: FeedbackStep }) {
  const workspace = useFeedbackWorkspace(initialStep);
  return (
    <main className="feedback-workspace">
      <PageHeader title="课后工作台" description="准备上下文、录入课堂记录、复核并生成家长反馈。单人反馈请在复核阶段只选择一名学生。" />
      {workspace.error && <StatusBanner tone="danger">{workspace.error}</StatusBanner>}
      {workspace.status && <StatusBanner tone="success">{workspace.status}</StatusBanner>}
      {workspace.legacyDraftAvailable && <StatusBanner tone="warning">另有一份旧“课堂录入”草稿仍保留在当前标签页。<Button variant="ghost" uiSize="sm" onClick={workspace.restoreLegacyDraft}>载入旧草稿</Button></StatusBanner>}
      <FeedbackWorkflow workspace={workspace} />
    </main>
  );
}
