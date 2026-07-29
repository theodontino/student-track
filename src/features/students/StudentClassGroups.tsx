"use client";

import { Badge, Button, EmptyState } from "@/components/ui";
import { studentSummaryHint } from "./student-list-utils";
import type { useStudentsWorkspace } from "./useStudentsWorkspace";

type Workspace = ReturnType<typeof useStudentsWorkspace>;

export function StudentClassGroups({ workspace }: { workspace: Workspace }) {
  if (workspace.classGroups.size === 0) {
    return workspace.search
      ? <EmptyState title="没有匹配的学生" description="请尝试姓名、学号、标签或班级中的其他关键词。" />
      : <EmptyState title="还没有添加学生" description="可以手动添加，或导入现有花名册。" action={<Button onClick={workspace.openCreate}>添加第一名学生</Button>} />;
  }

  return <div className="student-class-groups">{[...workspace.classGroups.entries()].map(([className, students]) => {
    const collapsed = workspace.collapsedClasses.has(className);
    return <section key={className} className="student-class-group">
      <button type="button" className="student-class-group__toggle" onClick={() => workspace.toggleClass(className)} aria-expanded={!collapsed}>
        <span>{className} <small>{students.length} 人</small></span>
        <span>{collapsed ? "展开" : "收起"}</span>
      </button>
      {!collapsed && <div className="student-list-rows">{students.map((student) => (
        <article key={student.id} className={`student-list-row${workspace.selectedStudent?.id === student.id ? " is-selected" : ""}`}>
          <button
            type="button"
            className="student-list-row__open"
            onPointerEnter={(event) => { if (event.pointerType === "mouse") workspace.beginStudentPreview(student.id); }}
            onPointerLeave={(event) => { if (event.pointerType === "mouse") workspace.endStudentPreview(); }}
            onFocus={() => workspace.showStudentPreview(student.id)}
            onBlur={workspace.endStudentPreview}
            onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); workspace.closeStudentPreview(); } }}
            onClick={() => workspace.openStudent(student.id)}
            aria-label={`打开${student.name}的学生档案`}
          >
            <span className={`student-list-row__avatar ${student.gender === "男" ? "is-male" : "is-female"}`} aria-hidden="true">{student.name[0]}</span>
            <span className="student-list-row__identity">
              <span><strong>{student.name}</strong><small>{student.studentId}</small></span>
              <span>{student.rosterStatus === "INACTIVE" && <Badge tone="warning">非活跃</Badge>}{student.labels.map((label) => <Badge key={label.id}>{label.name}</Badge>)}</span>
            </span>
            <span data-testid={`student-semester-score-${student.id}`} className="student-list-row__score">
              <span>本学期综合分</span>
              <strong>
                <span className="student-list-row__score-current">{student.semesterSummary?.score100 ?? "—"}</span>
                {student.semesterSummary?.score100 !== null && student.semesterSummary?.score100 !== undefined && <small className="student-list-row__score-maximum">/100</small>}
              </strong>
              <span>{studentSummaryHint(student.semesterSummary)}</span>
            </span>
          </button>
          <div className="student-list-row__actions">
            <small>生效：{new Date(student.statusEffectiveAt).toLocaleString("zh-CN")}</small>
            <Button
              uiSize="sm"
              variant={student.rosterStatus === "ACTIVE" ? "warning" : "secondary"}
              disabled={workspace.statusUpdatingId === student.id}
              onClick={() => void workspace.setRosterStatus(student, student.rosterStatus === "ACTIVE" ? "inactive" : "active")}
            >
              {workspace.statusUpdatingId === student.id ? "更新中…" : student.rosterStatus === "ACTIVE" ? "设为非活跃" : "恢复在读"}
            </Button>
          </div>
        </article>
      ))}</div>}
    </section>;
  })}</div>;
}
