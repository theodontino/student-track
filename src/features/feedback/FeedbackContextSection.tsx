"use client";

import SemesterPicker from "@/components/SemesterPicker";
import { Badge, Button, Input, Section, StatusBanner } from "@/components/ui";
import type { useFeedbackWorkspace } from "./useFeedbackWorkspace";

type Workspace = ReturnType<typeof useFeedbackWorkspace>;

export function FeedbackContextSection({ workspace }: { workspace: Workspace }) {
  const { context } = workspace;
  return (
    <Section title="当前课次" description="所有课堂记录、上下文和反馈都围绕这里选择的课次。" actions={<div className="feedback-stage-status"><Badge tone={context.sessionCode ? "info" : "neutral"}>课次</Badge><Badge tone={workspace.parsedResult ? "info" : "neutral"}>解析</Badge><Badge tone={workspace.confirmed ? "success" : "neutral"}>写入</Badge><Badge tone={workspace.activeStep === "export" ? "success" : "neutral"}>反馈计划</Badge></div>}>
      {workspace.groupProgress && <StatusBanner tone={workspace.groupProgress.status === "linked" ? "info" : "warning"}>
        <span>{workspace.groupProgress.status === "linked" && workspace.groupProgress.lesson
          ? `当前班属于“${workspace.groupProgress.group.name}”，主班为 ${workspace.groupProgress.leadClass?.name ?? workspace.groupProgress.leadClass?.code ?? "未设置"}；本课按第 ${workspace.groupProgress.lesson.sequence} 讲共同进度处理。${workspace.groupProgress.lesson.revision > 0 ? `已确认材料修订 ${workspace.groupProgress.lesson.revision}。` : "共同材料尚未确认。"}`
          : workspace.groupProgress.status === "lead_required"
            ? `当前班属于“${workspace.groupProgress.group.name}”，但尚未设置主班；本课暂不推进共同进度。`
            : `当前班属于“${workspace.groupProgress.group.name}”，但本课尚未进入班级组共同进度。`}</span>
        {workspace.groupProgress.lesson?.hasUnconfirmedChanges && <Button uiSize="sm" variant="secondary" onClick={() => void workspace.confirmGroupLessonMaterial()}>确认并共享共同材料</Button>}
      </StatusBanner>}
      <div className="feedback-context-section">
        <SemesterPicker semesterId={context.semesterId} onSemesterChange={workspace.onSemesterChange} className={context.className} onClassChange={workspace.onClassChange} sessionCode={context.sessionCode} onSessionChange={workspace.onSessionChange} refreshKey={workspace.sessionRefreshKey} />
        <div className="feedback-new-session">
          <label htmlFor="feedback-new-session-date">新课次日期</label>
          <Input id="feedback-new-session-date" type="date" value={workspace.newSessionDate} onChange={(event) => workspace.setNewSessionDate(event.target.value)} disabled={workspace.creatingSession} />
          <Button variant="secondary" onClick={() => void workspace.createSession()} disabled={!context.semesterId || !context.className || workspace.creatingSession}>{workspace.creatingSession ? "新建中…" : "新建课次"}</Button>
        </div>
      </div>
    </Section>
  );
}
