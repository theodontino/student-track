"use client";

import { Button, Dialog, FormField, Select, StatusBanner } from "@/components/ui";
import type { useStudentsWorkspace } from "./useStudentsWorkspace";

type Workspace = ReturnType<typeof useStudentsWorkspace>;

export function StudentTransferDialog({ workspace }: { workspace: Workspace }) {
  const student = workspace.transferTarget;
  const targetClasses = workspace.semesterClasses.filter((klass) => klass.id !== student?.classId);

  return (
    <Dialog
      open={Boolean(student)}
      title={student ? `转班：${student.name}` : "转班"}
      onClose={workspace.closeTransfer}
    >
      {student && <form onSubmit={(event) => { event.preventDefault(); void workspace.submitTransfer(); }} className="student-transfer-dialog">
        {workspace.transferError && <StatusBanner tone="danger">{workspace.transferError}</StatusBanner>}
        <div className="student-transfer-dialog__current">
          <strong>当前班级</strong>
          <span>{student.class || student.classCode || "未分班"}</span>
        </div>
        <FormField id="student-transfer-class" label="目标班级" description="只能选择当前学期已有班级，不允许手填班级名称。" required>
          <Select
            id="student-transfer-class"
            aria-label="目标班级"
            required
            value={workspace.transferClassId}
            onChange={(event) => workspace.setTransferClassId(event.target.value)}
          >
            <option value="">请选择目标班级</option>
            {targetClasses.map((klass) => <option key={klass.id} value={klass.id}>{klass.code}{klass.name ? ` · ${klass.name}` : ""}</option>)}
          </Select>
        </FormField>
        {targetClasses.length === 0 && <StatusBanner tone="warning">当前学期没有可选的其他班级，请先建立目标班级。</StatusBanner>}
        <div className="student-transfer-dialog__notice">
          <p>确认后，未来名单会使用新班级；历史课次、评价、考勤、沟通和已生成反馈不会移动。</p>
          <p>单人转班不会自动恢复非活跃状态。</p>
        </div>
        <div className="student-transfer-dialog__actions">
          <Button type="button" variant="secondary" onClick={workspace.closeTransfer} disabled={workspace.transferring}>取消</Button>
          <Button type="submit" disabled={workspace.transferring || targetClasses.length === 0}>{workspace.transferring ? "转班中…" : "确认转班"}</Button>
        </div>
      </form>}
    </Dialog>
  );
}
