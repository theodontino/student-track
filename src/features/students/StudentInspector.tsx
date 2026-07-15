"use client";

import { Badge, Button, EmptyState } from "@/components/ui";
import { studentSummaryHint } from "./student-list-utils";
import type { useStudentsWorkspace } from "./useStudentsWorkspace";

type Workspace = ReturnType<typeof useStudentsWorkspace>;

export function StudentInspector({ workspace }: { workspace: Workspace }) {
  const student = workspace.selectedStudent;
  if (!student) return <aside className="student-inspector"><EmptyState title="选择一名学生" description="从左侧名单选择后，在这里查看本学期摘要和档案入口。" /></aside>;
  const summary = student.semesterSummary;
  return <aside className="student-inspector" aria-label={`${student.name}档案预览`}>
    <header>
      <span className="student-inspector__avatar" aria-hidden="true">{student.name[0]}</span>
      <div><small>{student.class}</small><h2>{student.name}</h2><p>{student.studentId || "未填写学号"}</p></div>
    </header>
    <div className="student-inspector__labels">{student.labels.length > 0 ? student.labels.map((label) => <Badge key={label.id}>{label.name}</Badge>) : <span>暂无标签</span>}</div>
    <section className="student-inspector__score">
      <span>本学期综合分</span>
      <strong>{summary?.score100 ?? "—"}{summary?.score100 != null && <small>/100</small>}</strong>
      <p>{studentSummaryHint(summary)}</p>
      {summary && <dl><div><dt>20 分制</dt><dd>{summary.total20 ?? "—"}</dd></div><div><dt>评价课次</dt><dd>{summary.ratedSessionCount}</dd></div><div><dt>考勤记录</dt><dd>{summary.attendanceRecordedCount}</dd></div></dl>}
    </section>
    <div className="student-inspector__actions"><Button onClick={() => workspace.openStudent(student.id)}>打开完整档案</Button><Button variant="secondary" onClick={() => workspace.openEdit(student)}>编辑</Button><Button variant="ghost" className="student-inspector__delete" onClick={() => { workspace.setDeleteError(""); workspace.setDeleteTarget(student); }}>删除</Button></div>
  </aside>;
}
