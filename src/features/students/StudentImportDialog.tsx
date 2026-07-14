"use client";

import { Button, Dialog, StatusBanner } from "@/components/ui";
import type { useStudentsWorkspace } from "./useStudentsWorkspace";

type Workspace = ReturnType<typeof useStudentsWorkspace>;

export function StudentImportDialog({ workspace }: { workspace: Workspace }) {
  return (
    <Dialog open={workspace.showImportDialog} title="导入花名册" onClose={workspace.closeImport}>
      <div className="student-import-dialog">
        <StatusBanner tone="info"><strong>支持 .xlsx / .csv 文件</strong><br />表头需包含：姓名、班级、学号、性别（选填）</StatusBanner>
        <input
          key={workspace.importFile ? "selected" : "empty"}
          type="file"
          accept=".xlsx,.csv"
          disabled={workspace.importing}
          onChange={(event) => {
            workspace.setImportFile(event.target.files?.[0] ?? null);
            workspace.setImportResult(null);
          }}
        />
        {workspace.importResult?.success && <StatusBanner tone="success">成功导入 {workspace.importResult.successCount} / {workspace.importResult.total} 名学生{(workspace.importResult.errorCount ?? 0) > 0 && <div className="student-import-errors"><strong>{workspace.importResult.errorCount} 条失败：</strong>{workspace.importResult.errors?.map((message, index) => <span key={`${message}-${index}`}>{message}</span>)}</div>}</StatusBanner>}
        {workspace.importResult?.error && <StatusBanner tone="danger">{workspace.importResult.error}</StatusBanner>}
        <div className="student-import-dialog__actions"><Button variant="secondary" onClick={workspace.closeImport} disabled={workspace.importing}>{workspace.importResult?.success ? "完成" : "取消"}</Button><Button onClick={() => void workspace.importStudents()} disabled={!workspace.importFile || workspace.importing}>{workspace.importing ? "导入中…" : "开始导入"}</Button></div>
      </div>
    </Dialog>
  );
}
