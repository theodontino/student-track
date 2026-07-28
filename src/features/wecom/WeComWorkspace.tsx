"use client";

import Link from "next/link";
import { useState } from "react";
import { LoadingState, PageHeader, StatusBanner, Tabs } from "@/components/ui";
import { useWeComAccess } from "@/features/useWeComAccess";
import WeComAccessPanel from "./WeComAccessPanel";
import WccCandidateReviewPanel from "./WccCandidateReviewPanel";
import WccHandoffPanel from "./WccHandoffPanel";

type WeComView = "handoff" | "review";

export default function WeComWorkspace() {
  const access = useWeComAccess();
  const [view, setView] = useState<WeComView>("handoff");

  if (!access.hydrated) return <LoadingState label="正在检查企微家校入口…" />;

  return <main className="wecom-workspace">
    <PageHeader
      title="企微家校"
      description="显式扫描 handoff 中转包，在 Student Track 内完成提取、课次匹配与教师复核。"
      actions={<Link className="wecom-workspace__settings-link" href="/system/integrations#wecom-access">工具状态与使用须知</Link>}
    />
    {!access.enabled ? <>
      <StatusBanner tone="warning">该工作区尚未在本机启用。请先阅读第三方工具使用须知。</StatusBanner>
      <WeComAccessPanel />
    </> : <>
      <StatusBanner tone="info">业务数据只通过不可变 handoff 文件交付；Student Track 不启动或读取 WCC runtime。云端模型可能接收待提取的会话片段。</StatusBanner>
      <Tabs
        label="企微家校工作区分区"
        value={view}
        onChange={(value) => setView(value as WeComView)}
        items={[
          { value: "handoff", label: "接收与诊断" },
          { value: "review", label: "教师复核与入库" },
        ]}
      />
      <div role="tabpanel" className="wecom-workspace__panel">
        {view === "handoff" ? <WccHandoffPanel /> : <WccCandidateReviewPanel />}
      </div>
    </>}
  </main>;
}
