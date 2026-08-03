"use client";

import { Button, Input, PageHeader, Select } from "@/components/ui";
import { SemesterContextSelector } from "@/features/teaching-context/SemesterContextSelector";
import type { useStudentsWorkspace } from "./useStudentsWorkspace";

type Workspace = ReturnType<typeof useStudentsWorkspace>;

export function StudentListToolbar({ workspace }: { workspace: Workspace }) {
  return (
    <>
      <PageHeader
        title="学生档案"
        description="按学期查看学生四维平均表现和综合分；基础档案与标签保持全局。"
        context={<SemesterContextSelector value={workspace.selectedSemesterId} onChange={workspace.setSemesterId} compact />}
        actions={<div className="student-list-actions"><Button variant="secondary" onClick={workspace.openImport} disabled={!workspace.selectedSemesterId}>导入花名册</Button><Button onClick={workspace.openCreate} disabled={!workspace.selectedSemesterId}>添加学生</Button></div>}
      />
      <div className="student-list-search">
        <Input
          type="search"
          value={workspace.search}
          onChange={(event) => workspace.setSearch(event.target.value)}
          placeholder="按姓名、学号、标签或班级搜索..."
          aria-label="搜索学生"
        />
        <label className="student-list-sort">
          <span>花名册状态</span>
          <Select value={workspace.rosterFilter} onChange={(event) => workspace.setRosterFilter(event.target.value as typeof workspace.rosterFilter)} aria-label="学生花名册状态">
            <option value="all">全部学生</option>
            <option value="active">只看在读</option>
            <option value="inactive">只看非活跃</option>
          </Select>
        </label>
        <label className="student-list-sort">
          <span>班级内排序</span>
          <Select value={workspace.sort} onChange={(event) => workspace.setSort(event.target.value as typeof workspace.sort)} aria-label="学生排序方式">
            <option value="score-desc">综合分：高到低</option>
            <option value="score-asc">综合分：低到高</option>
            <option value="name">姓名顺序</option>
          </Select>
        </label>
        {workspace.search && <p>{workspace.filteredStudents.length} / {workspace.students.length} 名学生匹配</p>}
      </div>
    </>
  );
}
