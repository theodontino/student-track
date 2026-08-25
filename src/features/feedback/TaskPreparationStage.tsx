"use client";

import Link from "next/link";
import { useRef } from "react";
import { Button, SegmentedControl, Textarea } from "@/components/ui";
import type { FeedbackContextStudent } from "./context-types";
import type { FeedbackIntakeRunClient } from "./feedback-task-types";
import type { FeedbackTaskClassDraft, FeedbackTaskDraftV2, MaterialSelection } from "./feedback-task-state";
import styles from "./unified-feedback-workspace.module.css";

export type CommonMaterialOption = {
  lessonNumber: number;
  label: string;
  preview: string;
};

type Props = {
  draft: FeedbackTaskDraftV2;
  entry: FeedbackTaskClassDraft;
  run: FeedbackIntakeRunClient | null;
  students: FeedbackContextStudent[];
  busy: boolean;
  commonMaterialLabel: string;
  commonMaterialPreview: string;
  availableMaterial: MaterialSelection | null;
  commonMaterialOptions: CommonMaterialOption[];
  selectedCommonMaterialLesson: number | null;
  commonMaterialAction: "group" | "session" | "unavailable";
  commonMaterialHelp: string;
  onFiles: (files: File[]) => void;
  onScan: () => void;
  onEntry: (patch: Partial<FeedbackTaskClassDraft>) => void;
  onDraft: (patch: Partial<FeedbackTaskDraftV2>) => void;
  onCommonMaterialLesson: (lessonNumber: number | null) => void;
  onSaveCommonMaterial: () => void;
  onConfirmCommonMaterial: () => void;
  onContinue: () => void;
};

export function TaskPreparationStage(props: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const selected = new Set(props.entry.studentIds);
  const toggleStudent = (id: string) => props.onEntry({ studentIds: selected.has(id) ? props.entry.studentIds.filter((value) => value !== id) : [...props.entry.studentIds, id] });
  return <div className={styles.stageContent}>
    <div className={styles.entrances}>
      <div className={styles.dropzone} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); props.onFiles(Array.from(event.dataTransfer.files)); }}>
        <span className={styles.eyebrow}>入口 A · 临时投入</span><strong>拖入文件、文件夹或 ZIP</strong><p>助教 Excel、STEP 文本、学生 PDF；所有文件先整理，不在本阶段写入事实。</p>
        <Button variant="secondary" onClick={() => fileRef.current?.click()} disabled={props.busy}>选择材料</Button>
        <input ref={fileRef} hidden type="file" multiple onChange={(event) => { props.onFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
      </div>
      <div className={styles.inbox}><span className={styles.eyebrow}>入口 B · 固定目录</span><strong>读取反馈收件箱</strong><code>~/Library/Application Support/Student Track/feedback-inbox</code><Button variant="secondary" onClick={props.onScan} disabled={props.busy}>重新扫描</Button><small>只在教师打开任务时扫描，不移动、不删除源文件。</small></div>
    </div>
    <div className={styles.folderRow}><Button variant="ghost" onClick={() => folderRef.current?.click()} disabled={props.busy}>选择整个报告文件夹</Button><span>适合一次投入一批学生 PDF。</span><input ref={folderRef} hidden type="file" multiple {...({ webkitdirectory: "" } as Record<string, string>)} onChange={(event) => { props.onFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} /></div>
    {props.run && <div className={styles.runSummary}><div><strong>本班材料</strong><span>{props.run.sourceManifest.length} 个来源 · {props.run.status === "applied" ? "事实已确认" : props.run.issues.length ? `${props.run.issues.length} 项需核对` : "等待确认"}</span></div><div className={styles.fileList}>{props.run.sourceManifest.map((source, index) => <span key={`${source.name}:${index}`}>{source.kind ?? "文件"} · {source.name}</span>)}</div></div>}
    <section className={styles.candidates}><header><div><strong>本次反馈对象</strong><span>每班独立选择；确认范围后服务端保存。</span></div><div><Button uiSize="sm" variant="ghost" onClick={() => props.onEntry({ studentIds: props.students.map((student) => student.id) })}>全选</Button><Button uiSize="sm" variant="ghost" onClick={() => props.onEntry({ studentIds: [] })}>清空</Button></div></header><div className={styles.candidateGrid}>{props.students.map((student) => <label key={student.id} className={selected.has(student.id) ? styles.candidateSelected : ""}><input type="checkbox" checked={selected.has(student.id)} onChange={() => toggleStudent(student.id)} /><span><strong>{student.name}</strong><small>{student.studentId}</small></span></label>)}</div></section>
    <section className={styles.strategy}>
      <div className={styles.strategyHeading}><div><strong>课程公共材料与反馈策略</strong><span>班级组只设置一次；公共材料只作为课程背景。</span></div></div>
      <p className={styles.commonLesson}>{props.commonMaterialLabel}</p>{props.commonMaterialPreview && <div className={styles.commonLessonPreview}>{props.commonMaterialPreview}</div>}
      <div className={styles.commonMaterialEditor}>
        <label className={styles.commonLessonPicker}>选择学期公共材料<select value={props.selectedCommonMaterialLesson ?? ""} disabled={props.busy || props.commonMaterialAction === "unavailable"} onChange={(event) => props.onCommonMaterialLesson(event.target.value ? Number(event.target.value) : null)}><option value="">请选择公共材料</option>{props.commonMaterialOptions.map((option) => <option key={option.lessonNumber} value={option.lessonNumber}>{option.label}</option>)}</select><small>{props.commonMaterialHelp}</small></label>
        <div className={styles.commonMaterialActions}>
          {props.commonMaterialAction === "group" && <><Button variant="secondary" onClick={props.onSaveCommonMaterial} disabled={props.busy || !props.selectedCommonMaterialLesson}>保存为共同课草稿</Button><Button onClick={props.onConfirmCommonMaterial} disabled={props.busy || !props.selectedCommonMaterialLesson}>确认并共享本讲材料</Button></>}
          {props.commonMaterialAction === "session" && <Button onClick={props.onSaveCommonMaterial} disabled={props.busy || !props.selectedCommonMaterialLesson}>保存为本课公共材料</Button>}
          {!props.commonMaterialOptions.length && <Link className="ui-button ui-button--ghost ui-button--md" href="/feedback/tools?tool=materials">管理学期公共材料</Link>}
        </div>
      </div>
      <label className={styles.commonLessonPicker}>材料使用<select value={props.draft.materialSelection.mode} onChange={(event) => props.onDraft({ materialSelection: event.target.value === "none" ? { mode: "none" } : props.availableMaterial ?? { mode: "none" } })}><option value="none">本次不使用公共材料</option>{props.availableMaterial && <option value={props.availableMaterial.mode}>使用当前课次已确认公共材料</option>}</select></label>
      <div className={styles.strategyRows}>
        <label>生成方式<select value={props.draft.generationMode} onChange={(event) => props.onDraft({ generationMode: event.target.value as "standard" | "fast" })}><option value="standard">标准反馈</option><option value="fast">快速草稿</option></select></label>
        <label>详略<SegmentedControl label="详略" value={props.draft.preferences.length} onChange={(value) => props.onDraft({ preferences: { ...props.draft.preferences, length: value as FeedbackTaskDraftV2["preferences"]["length"] } })} items={[{ value: "inherit", label: "随家庭偏好" }, { value: "short", label: "简洁" }, { value: "standard", label: "标准" }, { value: "detailed", label: "详细" }]} /></label>
        <label>语气<SegmentedControl label="语气" value={props.draft.preferences.tone} onChange={(value) => props.onDraft({ preferences: { ...props.draft.preferences, tone: value as FeedbackTaskDraftV2["preferences"]["tone"] } })} items={[{ value: "inherit", label: "随现有偏好" }, { value: "gentle", label: "温和" }, { value: "professional", label: "专业" }]} /></label>
        <label className={styles.requirement}>总体要求<Textarea rows={3} value={props.draft.outputRequirement} onChange={(event) => props.onDraft({ outputRequirement: event.target.value })} /></label>
      </div>
    </section>
    <div className={styles.actions}><div><strong>准备完成后进入核对</strong><span>不会暗中写事实、建计划或调用模型。</span></div><div><Button onClick={props.onContinue} disabled={props.busy || !props.run || !props.entry.studentIds.length}>进入核对并确认</Button></div></div>
  </div>;
}
