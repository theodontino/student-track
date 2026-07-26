"use client";

import Link from "next/link";
import { useState } from "react";
import WeComWorkflowPanel from "@/components/wecom/WeComWorkflowPanel";
import { LoadingState, PageHeader, StatusBanner, Tabs } from "@/components/ui";
import { useWeComAccess } from "@/features/useWeComAccess";
import WeComAccessPanel from "./WeComAccessPanel";
import WeComRollbackPanel from "./WeComRollbackPanel";
import WccCandidateReviewPanel from "./WccCandidateReviewPanel";
import WccHandoffPanel from "./WccHandoffPanel";

type WeComView = "workflow" | "handoff" | "review";

export default function WeComWorkspace() {
  const access = useWeComAccess();
  const [view, setView] = useState<WeComView>("workflow");

  if (!access.hydrated) return <LoadingState label="正在检查企微家校入口…" />;

  return <main className="wecom-workspace">
    <PageHeader
      title="企微家校"
      description="连接可选本地工具，按消息回执增量提取、复核并回滚家校沟通。"
      actions={<Link className="wecom-workspace__settings-link" href="/system/integrations#wecom-access">工具状态与使用须知</Link>}
    />
    {!access.enabled ? <>
      <StatusBanner tone="warning">该工作区尚未在本机启用。请先阅读第三方工具使用须知。</StatusBanner>
      <WeComAccessPanel />
    </> : <>
      <StatusBanner tone="info">WeComCatch 为独立第三方本地工具；Student Track 不包含其源码和运行数据。云端模型可能接收待提取的会话片段。</StatusBanner>
      <Tabs
        label="企微家校工作区分区"
        value={view}
        onChange={(value) => setView(value as WeComView)}
        items={[
          { value: "workflow", label: "同步与导入" },
          { value: "handoff", label: "中转仓库" },
          { value: "review", label: "复核与回滚" },
        ]}
      />
      <div role="tabpanel" className="wecom-workspace__panel">
        {view === "workflow"
          ? <WeComWorkflowPanel title="同步与导入" description="保留旧 API 工作流作为本机兼容回退。" showFeedbackLink />
          : view === "handoff"
            ? <WccHandoffPanel />
            : <div className="space-y-4"><WccCandidateReviewPanel /><WeComRollbackPanel /></div>}
      </div>
    </>}
  </main>;
}
