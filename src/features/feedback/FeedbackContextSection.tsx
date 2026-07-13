"use client";

import SemesterPicker from "@/components/SemesterPicker";
import { Badge, Button, Input, Section } from "@/components/ui";
import type { useFeedbackWorkspace } from "./useFeedbackWorkspace";

type Workspace = ReturnType<typeof useFeedbackWorkspace>;

export function FeedbackContextSection({ workspace }: { workspace: Workspace }) {
  const { context } = workspace;
  return (
    <Section title="当前课次" description="所有课堂记录、上下文和反馈都围绕这里选择的课次。" actions={<div className="feedback-stage-status"><Badge tone={context.sessionCode ? "info" : "neutral"}>课次</Badge><Badge tone={workspace.parsedResult ? "info" : "neutral"}>解析</Badge><Badge tone={workspace.confirmed ? "success" : "neutral"}>写入</Badge><Badge tone={workspace.feedbackCards.length ? "success" : "neutral"}>反馈</Badge></div>}>
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
