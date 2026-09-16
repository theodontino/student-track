"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Dialog, Input, Select, StatusBanner } from "@/components/ui";
import type { useStudentsWorkspace } from "./useStudentsWorkspace";

type Workspace = ReturnType<typeof useStudentsWorkspace>;

export function StudentImportDialog({ workspace }: { workspace: Workspace }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileHint, setFileHint] = useState("");
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (workspace.showImportDialog) return;
    setFileHint("");
    setDragging(false);
  }, [workspace.showImportDialog]);
  const chooseFile = (files: FileList | File[] | null) => {
    if (workspace.importing) return;
    const selected = files ? Array.from(files) : [];
    if (selected.length > 1) {
      setFileHint("一次只能选择一个花名册文件。请保留需要分析的 .xlsx 或 .csv 文件后重试。");
      void workspace.selectImportFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    const file = selected[0] ?? null;
    if (!file) return;
    if (!/\.(xlsx|csv)$/i.test(file.name)) {
      setFileHint("仅支持 .xlsx 或 .csv 花名册文件。");
      void workspace.selectImportFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setFileHint("");
    void workspace.selectImportFile(file);
  };
  return (
    <Dialog open={workspace.showImportDialog} title="导入花名册" onClose={workspace.closeImport}>
      <div className="student-import-dialog">
        <StatusBanner tone="info"><strong>可直接选择机构原始 .xlsx / .csv</strong><br />当前学期：{workspace.selectedSemesterId || "未选择"}<br />系统会识别学员姓名、学员编号、班级编码、科目和教师；原表无需先删列。</StatusBanner>
        <input id="student-import-file" ref={fileInputRef} className="student-import-file-input" type="file" accept=".xlsx,.csv" aria-label="花名册文件" tabIndex={-1} disabled={workspace.importing} onChange={(event) => chooseFile(event.target.files)} />
        <section className={`student-import-file-picker ${dragging ? "is-dragging" : ""}`} aria-label="选择花名册文件" onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { event.preventDefault(); setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); chooseFile(event.dataTransfer.files); }}>
          <label htmlFor="student-import-file" className="student-import-file-target" role="button" tabIndex={workspace.importing ? -1 : 0} aria-disabled={workspace.importing} onKeyDown={(event) => { if (workspace.importing || (event.key !== "Enter" && event.key !== " ")) return; event.preventDefault(); if (fileInputRef.current) { fileInputRef.current.value = ""; fileInputRef.current.click(); } }} onClick={() => { if (fileInputRef.current) fileInputRef.current.value = ""; }}>
            <strong>{workspace.importFile ? "已选择花名册" : "选择或拖入花名册文件"}</strong>
            <span>{workspace.importFile ? workspace.importFile.name : "支持 .xlsx、.csv；一次仅分析一个文件"}</span>
            <span className="student-import-file-target__action" aria-hidden="true">{workspace.importFile ? "重新选择" : "选择花名册文件"}</span>
          </label>
          {workspace.importFile && <div><Button type="button" uiSize="sm" variant="ghost" onClick={() => { setFileHint(""); void workspace.selectImportFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; }} disabled={workspace.importing}>清除已选文件</Button></div>}
          <small>{workspace.importing ? "正在分析文件…" : workspace.importFile ? "文件已选定，正在或已经完成分析。" : "选择文件后立即开始分析，不会上传保存原始文件。"}</small>
        </section>
        <div className="student-import-file-message" role="status" aria-live="polite">{fileHint || (workspace.importing ? "正在分析花名册文件" : workspace.importFile ? `已选择：${workspace.importFile.name}` : "尚未选择文件")}</div>
        {workspace.importAnalysis && <section className="student-import-scope">
          <header><strong>选择本学期要导入的班级</strong><span>共识别 {workspace.importAnalysis.rowCount ?? 0} 行、{workspace.importAnalysis.classes?.length ?? 0} 个班级</span></header>
          <div className="student-import-scope__filters">
            <label>科目<Select value={workspace.importSubject} onChange={(event) => workspace.setImportSubject(event.target.value)}><option value="">全部科目</option>{workspace.importAnalysis.subjects?.map((subject) => <option key={subject} value={subject}>{subject}</option>)}</Select></label>
            <label>教师<Select value={workspace.importTeacher} onChange={(event) => workspace.setImportTeacher(event.target.value)}><option value="">全部教师</option>{workspace.availableImportTeachers.map((teacher) => <option key={teacher} value={teacher}>{teacher}</option>)}</Select></label>
            <label>搜索<Input value={workspace.importSearch} placeholder="班级、姓名或学号" onChange={(event) => workspace.setImportSearch(event.target.value)} /></label>
          </div>
          <div className="student-import-scope__classes">{workspace.visibleImportClasses.length ? workspace.visibleImportClasses.map((item) => <label key={item.classCode}>
            <input type="checkbox" checked={workspace.selectedImportClassCodes.has(item.classCode)} onChange={() => workspace.toggleImportClass(item.classCode)} />
            <span><strong>{item.className || item.classCode}</strong><small>{item.subject} · {item.teacher} · {item.classCode} · {item.rowCount} 人</small></span>
          </label>) : <p>当前筛选下没有班级。</p>}</div>
          <small>已选择 {workspace.selectedImportClassCodes.size} 个班级。搜索只过滤列表，不会改变选择。</small>
        </section>}
        {workspace.importResult?.mode === "preview" && !workspace.importResult.blocked && <StatusBanner tone="warning"><strong>预览：将处理 {workspace.importResult.rowCount ?? 0} 行</strong>{workspace.importResult.changes?.length ? <div className="student-import-errors">{workspace.importResult.changes.map((change, index) => <span key={index}>{String(change.kind)}：{String(change.studentId ?? change.classCode ?? "")}</span>)}</div> : <div>没有检测到需要变更的资料。</div>}<div>请确认预览无误后再次点击“确认写入”。</div></StatusBanner>}
        {workspace.importResult?.mode === "committed" && <StatusBanner tone="success">已写入 {workspace.importResult.enrollmentsUpdated ?? workspace.importResult.total ?? 0} 条学期归属，新增学生 {workspace.importResult.studentsCreated ?? 0} 人。</StatusBanner>}
        {workspace.importResult?.success && workspace.importResult.mode !== "preview" && workspace.importResult.successCount !== undefined && <StatusBanner tone="success">成功导入 {workspace.importResult.successCount} / {workspace.importResult.total} 名学生{(workspace.importResult.errorCount ?? 0) > 0 && <div className="student-import-errors"><strong>{workspace.importResult.errorCount} 条失败：</strong>{workspace.importResult.errors?.map((message, index) => <span key={`${message}-${index}`}>{message}</span>)}</div>}</StatusBanner>}
        {workspace.importResult?.error && <StatusBanner tone="danger"><strong>{workspace.importResult.error}</strong>{workspace.importResult.errors?.length ? <div className="student-import-errors">{workspace.importResult.errors.map((message, index) => <span key={`${message}-${index}`}>{message}</span>)}</div> : null}</StatusBanner>}
        <div className="student-import-dialog__actions"><Button variant="secondary" onClick={workspace.closeImport} disabled={workspace.importing}>{workspace.importResult?.mode === "committed" ? "完成" : "取消"}</Button><Button onClick={() => void workspace.importStudents()} disabled={!workspace.importFile || !workspace.selectedSemesterId || workspace.importing || workspace.importResult?.mode === "committed" || !workspace.importAnalysis || workspace.selectedImportClassCodes.size === 0}>{workspace.importing ? "处理中…" : workspace.importResult?.mode === "preview" ? "确认写入" : "预览导入"}</Button></div>
      </div>
    </Dialog>
  );
}
