"use client";

import { Button, ConfirmDialog, ErrorState, LoadingState, StatusBanner } from "@/components/ui";
import { StudentClassGroups } from "./StudentClassGroups";
import { StudentEditorDialog } from "./StudentEditorDialog";
import { StudentImportDialog } from "./StudentImportDialog";
import { StudentListToolbar } from "./StudentListToolbar";
import { useStudentsWorkspace } from "./useStudentsWorkspace";

export default function StudentsWorkspace() {
  const workspace = useStudentsWorkspace();

  if (!workspace.hydrated || (workspace.loading && workspace.students.length === 0)) {
    return <LoadingState label="正在加载学生档案…" />;
  }
  if (workspace.loadError && workspace.students.length === 0) {
    return <ErrorState message={workspace.loadError} action={<Button onClick={() => void workspace.fetchStudents()}>重试</Button>} />;
  }

  return (
    <main className="student-list-workspace">
      <StudentListToolbar workspace={workspace} />
      {workspace.loadError && <StatusBanner tone="danger">{workspace.loadError} <Button uiSize="sm" variant="secondary" onClick={() => void workspace.fetchStudents()}>重试</Button></StatusBanner>}
      <StudentClassGroups workspace={workspace} />
      <StudentEditorDialog workspace={workspace} />
      <StudentImportDialog workspace={workspace} />
      <ConfirmDialog
        open={Boolean(workspace.deleteTarget)}
        title="删除学生"
        description={<>{workspace.deleteError && <StatusBanner tone="danger">{workspace.deleteError}</StatusBanner>}<p>确定删除 {workspace.deleteTarget?.name}？将同时删除该学生的所有评分、事件和沟通记录。</p></>}
        confirmLabel="删除学生"
        danger
        busy={workspace.deleting}
        onConfirm={() => void workspace.confirmDelete()}
        onClose={() => { if (!workspace.deleting) workspace.setDeleteTarget(null); }}
      />
    </main>
  );
}
