"use client";

import {
  Badge,
  Button,
  Input,
  Section,
  Select,
  StatusBanner,
  Textarea,
} from "@/components/ui";
import type { useFeedbackWorkspace } from "./useFeedbackWorkspace";
import { FeedbackScriptLibraryPanel } from "./FeedbackScriptLibraryPanel";

type Workspace = ReturnType<typeof useFeedbackWorkspace>;

const statusCopy = {
  parsing: { label: "解析中", tone: "neutral" as const },
  matched: { label: "待确认", tone: "info" as const },
  needs_match: { label: "需匹配", tone: "warning" as const },
  confirmed: { label: "已采用", tone: "success" as const },
  error: { label: "未采用", tone: "danger" as const },
};

const directoryInputProps = {
  webkitdirectory: "",
  directory: "",
};

function arrayText(values: string[]) {
  return values.join("\n");
}

export function FeedbackMaterialsPanel({ workspace }: { workspace: Workspace }) {
  const classStudents = workspace.assessmentStudents;
  const material = workspace.lessonMaterial;

  return (
    <Section
      title="本节反馈材料"
      description="生成前，模型会按班级整理一次课程摘要；个人报告和现有记录仍只负责证明对应学生的真实表现。"
      className="feedback-materials"
      actions={<div className="feedback-stage-status">
        <Badge tone={workspace.lessonMaterialNeedsOrganization ? "warning" : "info"}>
          {workspace.lessonMaterialNeedsOrganization ? "文字待整理" : "课程材料已整理"}
        </Badge>
        <Badge tone={workspace.assessmentConfirmedCount ? "success" : "neutral"}>
          已采用 {workspace.assessmentConfirmedCount} 份报告
        </Badge>
      </div>}
    >
      <div className="feedback-materials__body">
        <FeedbackScriptLibraryPanel workspace={workspace} />
        <div className="feedback-materials__copy">
          <div className="feedback-materials__field">
            <label htmlFor="feedback-group-material">群反馈原文</label>
            <p>自动提取课堂内容、重点、课堂说明和课后作业。</p>
            <Textarea
              id="feedback-group-material"
              value={workspace.groupFeedbackRaw}
              onChange={(event) => workspace.updateGroupFeedbackRaw(event.target.value)}
              rows={8}
              placeholder="粘贴发在班级群里的课程反馈…"
            />
          </div>
          <div className="feedback-materials__field">
            <label htmlFor="feedback-assessment-brief">出门测统一说明</label>
            <p>只提取考查范围和订正建议；“孩子存在错误”等模板判断不会作为个体证据。</p>
            <Textarea
              id="feedback-assessment-brief"
              value={workspace.assessmentBriefRaw}
              onChange={(event) => workspace.updateAssessmentBriefRaw(event.target.value)}
              rows={8}
              placeholder="粘贴统一的出门测说明话术…"
            />
          </div>
        </div>

        <div className="feedback-materials__bulk">
          <div>
            <strong>批量整理文字材料</strong>
            <span>两段文字一次整理，结果可继续修改。</span>
          </div>
          <div>
            <Button
              onClick={workspace.organizeLessonMaterial}
              disabled={!workspace.groupFeedbackRaw.trim() && !workspace.assessmentBriefRaw.trim()}
            >
              一键整理全部
            </Button>
            <Button
              variant="ghost"
              onClick={workspace.clearLessonMaterials}
              disabled={!workspace.groupFeedbackRaw && !workspace.assessmentBriefRaw}
            >
              清空文字
            </Button>
          </div>
        </div>

        {(material.lessonTitle
          || material.classroomContent.length
          || material.classroomFocus.length
          || material.assessmentFocus.length) && (
          <details className="feedback-materials__structured" open>
            <summary>
              <span>
                <strong>整理结果</strong>
                <small>每行一项，修改会直接进入反馈 Prompt</small>
              </span>
              <Badge tone="info">可编辑</Badge>
            </summary>
            <div className="feedback-materials__structured-grid">
              <label>
                <span>课程主题</span>
                <Input
                  value={material.lessonTitle}
                  onChange={(event) => workspace.updateLessonMaterialSection("lessonTitle", event.target.value)}
                />
              </label>
              <label>
                <span>课堂内容</span>
                <Textarea
                  rows={4}
                  value={arrayText(material.classroomContent)}
                  onChange={(event) => workspace.updateLessonMaterialSection("classroomContent", event.target.value)}
                />
              </label>
              <label>
                <span>课堂重点</span>
                <Textarea
                  rows={4}
                  value={arrayText(material.classroomFocus)}
                  onChange={(event) => workspace.updateLessonMaterialSection("classroomFocus", event.target.value)}
                />
              </label>
              <label>
                <span>课堂说明与处理</span>
                <Textarea
                  rows={4}
                  value={arrayText(material.classroomExplanation)}
                  onChange={(event) => workspace.updateLessonMaterialSection("classroomExplanation", event.target.value)}
                />
              </label>
              <label>
                <span>出门测范围</span>
                <Textarea
                  rows={4}
                  value={arrayText(material.assessmentFocus)}
                  onChange={(event) => workspace.updateLessonMaterialSection("assessmentFocus", event.target.value)}
                />
              </label>
              <label>
                <span>订正建议</span>
                <Textarea
                  rows={4}
                  value={arrayText(material.correctionAdvice)}
                  onChange={(event) => workspace.updateLessonMaterialSection("correctionAdvice", event.target.value)}
                />
              </label>
            </div>
          </details>
        )}

        {material.lessonSummary && (
          <div className="feedback-materials__lesson-summary">
            <div>
              <strong>本班本课课程认识</strong>
              <Badge tone={material.lessonSummaryStatus === "model" ? "success" : "warning"}>
                {material.lessonSummaryStatus === "model" ? "模型已整理" : "安全降级摘要"}
              </Badge>
            </div>
            <p>{material.lessonSummary}</p>
            <small>
              每班每课只整理一次。系统可匿名借用一份已确认出门测的题量和知识点结构，
              但不会把该生姓名、分数、答案或错题结论带入公共摘要。
            </small>
          </div>
        )}

        <div className="feedback-pdf-import">
          <div className="feedback-pdf-import__heading">
            <div>
              <strong>学生出门测 PDF</strong>
              <p>优先选择整个报告文件夹。系统先按本课次班级名单核对，再以两份并发持续解析。</p>
            </div>
            <div className="feedback-pdf-import__pickers">
              <label className={workspace.context.sessionCode && !workspace.assessmentBatchBusy ? "is-enabled is-primary" : ""}>
                {workspace.assessmentBatchBusy ? "文件夹处理中…" : "选择报告文件夹"}
                <input
                  type="file"
                  accept=".pdf,application/pdf"
                  multiple
                  {...directoryInputProps}
                  disabled={!workspace.context.sessionCode || workspace.assessmentBatchBusy}
                  onChange={(event) => {
                    void workspace.importAssessmentFolder(event.target.files);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
              <label className={workspace.context.sessionCode && !workspace.assessmentBatchBusy ? "is-enabled" : ""}>
                补选 PDF
                <input
                  type="file"
                  accept=".pdf,application/pdf"
                  multiple
                  disabled={!workspace.context.sessionCode || workspace.assessmentBatchBusy}
                  onChange={(event) => {
                    void workspace.importAssessmentPdfs(event.target.files);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
            </div>
          </div>

          {workspace.assessmentFolderPlan && (
            <div className="feedback-folder-plan">
              <div>
                <strong>
                  {workspace.assessmentFolderPlan.folderName
                    ? `文件夹：${workspace.assessmentFolderPlan.folderName}`
                    : "文件夹名单核对"}
                </strong>
                <span>
                  {workspace.assessmentFolderPlan.totalPdfCount} 份 PDF ·
                  命中 {workspace.assessmentFolderPlan.matched.length} 人 ·
                  缺少 {workspace.assessmentFolderPlan.missingStudents.length} 人 ·
                  忽略 {workspace.assessmentFolderPlan.ignoredFileCount} 份
                </span>
              </div>
              {workspace.assessmentFolderPlan.missingStudents.length > 0 && (
                <details>
                  <summary>查看缺少名单</summary>
                  <p>{workspace.assessmentFolderPlan.missingStudents.map((student) => student.name).join("、")}</p>
                </details>
              )}
              {workspace.assessmentFolderPlan.duplicateStudents.length > 0 && (
                <p className="is-warning">
                  以下学生发现多份候选文件，仅处理第一份：
                  {workspace.assessmentFolderPlan.duplicateStudents.join("、")}
                </p>
              )}
              <small>额外学生或无关 PDF 不进入队列；缺少报告不会阻止继续生成反馈。</small>
            </div>
          )}

          <div className="feedback-pdf-import__bulk">
            <span>
              {workspace.assessmentImports.length
                ? `${workspace.assessmentImports.length} 份 · ${workspace.assessmentReadyCount} 待确认 · ${workspace.assessmentAttentionCount} 需处理`
                : "尚未选择报告"}
            </span>
            <div>
              <Button
                uiSize="sm"
                onClick={workspace.confirmAllAssessmentMatches}
                disabled={workspace.assessmentReadyCount === 0 || workspace.assessmentBatchBusy}
              >
                批量确认匹配
              </Button>
              <Button
                uiSize="sm"
                variant="secondary"
                onClick={workspace.removeFailedAssessmentImports}
                disabled={!workspace.assessmentImports.some((item) => item.status === "error")}
              >
                移除失败项
              </Button>
              <Button
                uiSize="sm"
                variant="ghost"
                onClick={workspace.clearAssessmentImports}
                disabled={!workspace.assessmentImports.length || workspace.assessmentBatchBusy}
              >
                清空全部
              </Button>
            </div>
          </div>

          {workspace.assessmentImports.length > 0 && (
            <div className="feedback-pdf-import__list">
              {workspace.assessmentImports.map((item) => {
                const status = statusCopy[item.status];
                return (
                  <article key={item.id} className={`feedback-pdf-row is-${item.status}`}>
                    <div className="feedback-pdf-row__main">
                      <div>
                        <strong>{item.reportStudentName || item.matchedStudentName || item.fileName}</strong>
                        <Badge tone={status.tone}>{status.label}</Badge>
                      </div>
                      <span title={item.fileName}>{item.fileName}</span>
                      {item.evidence && (
                        <small>
                          {item.evidence.reportTitle || "出门测"} · {item.evidence.totalQuestions}题 ·
                          正确率 {item.evidence.correctRate}% · 错题 {item.evidence.wrongItems.length}
                        </small>
                      )}
                      {item.error && <small className="is-error">{item.error}</small>}
                    </div>

                    <div className="feedback-pdf-row__actions">
                      {item.status !== "parsing" && item.status !== "confirmed" && item.evidence && (
                        <Select
                          aria-label={`${item.fileName}匹配学生`}
                          value={item.matchedStudentId}
                          onChange={(event) => workspace.matchAssessmentItem(item.id, event.target.value)}
                        >
                          <option value="">选择学生</option>
                          {classStudents.map((student) => (
                            <option key={student.id} value={student.id}>{student.name}</option>
                          ))}
                        </Select>
                      )}
                      {item.status === "matched" && (
                        <Button uiSize="sm" variant="secondary" onClick={() => workspace.confirmAssessmentItem(item.id)}>
                          确认
                        </Button>
                      )}
                      <Button uiSize="sm" variant="ghost" onClick={() => workspace.removeAssessmentItem(item.id)}>
                        移除
                      </Button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          {!workspace.context.sessionCode && (
            <StatusBanner tone="warning">请先选择课次，系统才能用当前班级名单匹配 PDF。</StatusBanner>
          )}
          <StatusBanner tone="info">
            课程材料绑定当前课次；一份代表性 PDF 可匿名帮助建立课程与母题结构认识。每名学生的成绩、答案和错题仍只进入其本人 Prompt。
          </StatusBanner>
        </div>
      </div>
    </Section>
  );
}
