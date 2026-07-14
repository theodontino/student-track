"use client";

import { Button, Input, PageHeader } from "@/components/ui";
import { SemesterContextSelector } from "@/features/teaching-context";
import type { useStudentsWorkspace } from "./useStudentsWorkspace";

type Workspace = ReturnType<typeof useStudentsWorkspace>;

export function StudentListToolbar({ workspace }: { workspace: Workspace }) {
  return (
    <>
      <PageHeader
        title="学生档案"
        description="按学期查看学生四维平均表现和综合分；基础档案与标签保持全局。"
        context={<SemesterContextSelector value={workspace.selectedSemesterId} onChange={workspace.setSemesterId} compact />}
        actions={<div className="student-list-actions"><Button variant="secondary" onClick={workspace.openImport}>导入花名册</Button><Button onClick={workspace.openCreate}>添加学生</Button></div>}
      />
      <div className="student-list-search">
        <Input
          type="search"
          value={workspace.search}
          onChange={(event) => workspace.setSearch(event.target.value)}
          placeholder="按姓名、学号、标签或班级搜索..."
          aria-label="搜索学生"
        />
        {workspace.search && <p>{workspace.filteredStudents.length} / {workspace.students.length} 名学生匹配</p>}
      </div>
    </>
  );
}
