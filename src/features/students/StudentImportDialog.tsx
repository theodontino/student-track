"use client";

import { Button, Dialog, StatusBanner } from "@/components/ui";
import type { useStudentsWorkspace } from "./useStudentsWorkspace";

type Workspace = ReturnType<typeof useStudentsWorkspace>;

export function StudentImportDialog({ workspace }: { workspace: Workspace }) {
  return (
    <Dialog open={workspace.showImportDialog} title="导入花名册" onClose={workspace.closeImport}>
      <div className="student-import-dialog">
        <StatusBanner tone="info"><strong>支持 .xlsx / .csv 文件</strong><br />当前学期：{workspace.selectedSemesterId || "未选择"}<br />表头需包含：姓名、班级、学号、性别（选填）</StatusBanner>
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
        {workspace.importResult?.mode === "preview" && !workspace.importResult.blocked && <StatusBanner tone="warning"><strong>预览：将处理 {workspace.importResult.rowCount ?? 0} 行</strong>{workspace.importResult.changes?.length ? <div className="student-import-errors">{workspace.importResult.changes.map((change, index) => <span key={index}>{String(change.kind)}：{String(change.studentId ?? change.classCode ?? "")}</span>)}</div> : <div>没有检测到需要变更的资料。</div>}<div>请确认预览无误后再次点击“确认写入”。</div></StatusBanner>}
        {workspace.importResult?.mode === "committed" && <StatusBanner tone="success">已写入 {workspace.importResult.enrollmentsUpdated ?? workspace.importResult.total ?? 0} 条学期归属，新增学生 {workspace.importResult.studentsCreated ?? 0} 人。</StatusBanner>}
        {workspace.importResult?.success && workspace.importResult.mode !== "preview" && workspace.importResult.successCount !== undefined && <StatusBanner tone="success">成功导入 {workspace.importResult.successCount} / {workspace.importResult.total} 名学生{(workspace.importResult.errorCount ?? 0) > 0 && <div className="student-import-errors"><strong>{workspace.importResult.errorCount} 条失败：</strong>{workspace.importResult.errors?.map((message, index) => <span key={`${message}-${index}`}>{message}</span>)}</div>}</StatusBanner>}
        {workspace.importResult?.error && <StatusBanner tone="danger">{workspace.importResult.error}</StatusBanner>}
        <div className="student-import-dialog__actions"><Button variant="secondary" onClick={workspace.closeImport} disabled={workspace.importing}>{workspace.importResult?.mode === "committed" ? "完成" : "取消"}</Button><Button onClick={() => void workspace.importStudents()} disabled={!workspace.importFile || !workspace.selectedSemesterId || workspace.importing || workspace.importResult?.mode === "committed"}>{workspace.importing ? "处理中…" : workspace.importResult?.mode === "preview" ? "确认写入" : "预览导入"}</Button></div>
      </div>
    </Dialog>
  );
}
