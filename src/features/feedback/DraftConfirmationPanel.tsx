"use client";

import { DraftStudentCard, ReviewSummary } from "@/features/entry";
import { Button, EmptyState, Section } from "@/components/ui";
import type { useFeedbackWorkspace } from "./useFeedbackWorkspace";

type Workspace = ReturnType<typeof useFeedbackWorkspace>;

export function DraftConfirmationPanel({ workspace }: { workspace: Workspace }) {
  return (
    <Section title="结构化记录确认" description="确认后才会写入评价、考勤、事件和沟通。" actions={<Button onClick={() => void workspace.confirm()} disabled={!workspace.canConfirm}>{workspace.confirming ? "写入中…" : workspace.confirmed ? "已写入" : "确认写入"}</Button>}>
      <div className="feedback-draft-confirmation">
        {workspace.corrections.length > 0 && <div className="entry-corrections">{workspace.corrections.map((correction, index) => <div key={`${correction.original}-${index}`}><span>{correction.original}</span><strong>→ {correction.corrected}</strong><small>{correction.confidence}</small></div>)}</div>}
        {workspace.reviewResult && <ReviewSummary review={workspace.reviewResult} />}
        {!workspace.parsedResult ? <EmptyState title="等待解析课堂回顾" description="解析后，学生记录会显示在这里供你确认。" /> : <div className="feedback-draft-list">{workspace.parsedResult.students.map((student, index) => <DraftStudentCard key={`${student.name}-${index}`} student={student} onAttendanceChange={(present) => workspace.setParsedAttendance(index, present)} />)}</div>}
      </div>
    </Section>
  );
}
