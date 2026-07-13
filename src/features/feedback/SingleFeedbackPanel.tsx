"use client";

import { Button, Select, Section, Textarea } from "@/components/ui";
import type { useFeedbackWorkspace } from "./useFeedbackWorkspace";

type Workspace = ReturnType<typeof useFeedbackWorkspace>;

export function SingleFeedbackPanel({ workspace }: { workspace: Workspace }) {
  const availableStudents = workspace.students.filter((student) => !workspace.context.className || student.class === workspace.context.className);
  return (
    <Section title="单人反馈" description="为一名学生按当前课次生成；未选课次时按最近天数汇总。">
      <div className="feedback-single">
        <div className="feedback-single__controls">
          <label><span>学生</span><Select value={workspace.singleStudentId} onChange={(event) => workspace.setSingleStudentId(event.target.value)}><option value="">选择学生</option>{availableStudents.map((student) => <option key={student.id} value={student.id}>{student.name}（{student.class}）</option>)}</Select></label>
          {!workspace.context.sessionCode && <label><span>时间范围</span><Select value={workspace.singleDays} onChange={(event) => workspace.setSingleDays(Number(event.target.value))}><option value={7}>近 7 天</option><option value={14}>近 14 天</option><option value={30}>近 30 天</option></Select></label>}
          <Button onClick={() => void workspace.generateSingleFeedback()} disabled={!workspace.singleStudentId || workspace.singleLoading}>{workspace.singleLoading ? "生成中…" : "生成单人反馈"}</Button>
        </div>
        {workspace.singleFeedback && <Textarea aria-label="单人反馈内容" value={workspace.singleFeedback} onChange={(event) => workspace.setSingleFeedback(event.target.value)} rows={6} />}
      </div>
    </Section>
  );
}
