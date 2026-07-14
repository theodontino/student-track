"use client";

import { Button, Dialog, FormField, Input, Select, StatusBanner } from "@/components/ui";
import type { useStudentsWorkspace } from "./useStudentsWorkspace";

type Workspace = ReturnType<typeof useStudentsWorkspace>;

const PRESET_TAGS = [
  "#逻辑强", "#基础弱", "#主动", "#被动", "#调皮",
  "#敏感", "#内向", "#外向", "#注意力差", "#爱发言",
];

export function StudentEditorDialog({ workspace }: { workspace: Workspace }) {
  return (
    <Dialog
      open={workspace.showStudentDialog}
      title={workspace.editingStudent ? "编辑学生" : "添加学生"}
      onClose={workspace.closeStudentDialog}
    >
      <form onSubmit={(event) => { event.preventDefault(); void workspace.submitStudent(); }} className="student-editor-form">
        {workspace.formError && <StatusBanner tone="danger">{workspace.formError}</StatusBanner>}
        <FormField id="student-name" label="姓名" required>
          <Input id="student-name" required value={workspace.form.name} onChange={(event) => workspace.setForm({ ...workspace.form, name: event.target.value })} />
        </FormField>
        <div className="student-editor-form__row">
          <FormField id="student-class-code" label="班级编号" required>
            <Input id="student-class-code" required placeholder="如：G3-01" value={workspace.form.classCode} onChange={(event) => workspace.setForm({ ...workspace.form, classCode: event.target.value })} />
          </FormField>
          <FormField id="student-number" label="学号" required>
            <Input id="student-number" required value={workspace.form.studentId} onChange={(event) => workspace.setForm({ ...workspace.form, studentId: event.target.value })} />
          </FormField>
        </div>
        <FormField id="student-gender" label="性别">
          <Select id="student-gender" value={workspace.form.gender} onChange={(event) => workspace.setForm({ ...workspace.form, gender: event.target.value })}><option value="男">男</option><option value="女">女</option></Select>
        </FormField>
        <FormField id="student-label" label="标签" description="输入后按回车，或选择下方常用标签。">
          <div className="student-editor-form__label-input">
            <Input id="student-label" value={workspace.labelInput} onChange={(event) => workspace.setLabelInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); workspace.addLabel(); } }} />
            <Button type="button" variant="secondary" onClick={() => workspace.addLabel()}>添加</Button>
          </div>
          <div className="student-editor-form__presets">{PRESET_TAGS.filter((tag) => !workspace.form.labelNames.includes(tag)).map((tag) => <button key={tag} type="button" onClick={() => workspace.addLabel(tag)}>{tag}</button>)}</div>
          {workspace.form.labelNames.length > 0 && <div className="student-editor-form__labels">{workspace.form.labelNames.map((label) => <span key={label}>{label}<button type="button" aria-label={`移除${label}`} onClick={() => workspace.removeLabel(label)}>×</button></span>)}</div>}
        </FormField>
        <div className="student-editor-form__actions"><Button type="button" variant="secondary" onClick={workspace.closeStudentDialog} disabled={workspace.submitting}>取消</Button><Button type="submit" disabled={workspace.submitting}>{workspace.submitting ? "保存中…" : "保存"}</Button></div>
      </form>
    </Dialog>
  );
}
