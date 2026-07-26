"use client";

import { useMemo, useState } from "react";
import { requestJson } from "@/lib/api-client";
import {
  assessmentEvidenceByStudent,
  planAssessmentFolderImport,
  type AssessmentFolderPlan,
  type AssessmentImportItem,
  type AssessmentPdfParseResponse,
} from "@/lib/feedback-materials";
import type { FeedbackStudentOption } from "./types";

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

interface UseAssessmentPdfImportsInput {
  sessionCode: string;
  students: FeedbackStudentOption[];
  onInputsChanged: (message?: string) => void;
  setError: (message: string) => void;
  setStatus: (message: string) => void;
}

export function useAssessmentPdfImports(input: UseAssessmentPdfImportsInput) {
  const [items, setItems] = useState<AssessmentImportItem[]>([]);
  const [folderPlan, setFolderPlan] = useState<AssessmentFolderPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const evidenceByStudent = useMemo(() => assessmentEvidenceByStudent(items), [items]);

  async function processPdfs(
    selectedFiles: File[],
    expectedMatches: Array<{ studentId: string; studentName: string }> = [],
    completionMessage = "",
  ) {
    if (!selectedFiles.length) return;
    const boundSessionCode = input.sessionCode;

    const batchId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const pendingItems = selectedFiles.map((file, index): AssessmentImportItem => ({
      id: `${batchId}-${index}`,
      fileName: file.name,
      status: "parsing",
      reportStudentName: "",
      reportStudentId: "",
      matchedStudentId: expectedMatches[index]?.studentId ?? "",
      matchedStudentName: expectedMatches[index]?.studentName ?? "",
      evidence: null,
      error: "",
    }));
    setItems((current) => [...current, ...pendingItems]);
    setBusy(true);
    input.setError("");
    input.setStatus(`正在批量解析 ${selectedFiles.length} 份出门测报告…`);

    let cursor = 0;
    async function worker() {
      while (cursor < selectedFiles.length) {
        const index = cursor;
        cursor += 1;
        const file = selectedFiles[index];
        const itemId = pendingItems[index].id;
        try {
          const formData = new FormData();
          formData.set("sessionCode", boundSessionCode);
          formData.set("file", file);
          const parsed = await requestJson<AssessmentPdfParseResponse>("/api/feedback/assessment-pdf", {
            method: "POST",
            body: formData,
          });
          const expected = expectedMatches[index];
          const conflictsWithFolderMatch = Boolean(
            expected
            && parsed.matchedStudentId
            && parsed.matchedStudentId !== expected.studentId
          );
          setItems((current) => current.map((item) => item.id === itemId ? {
            ...item,
            status: conflictsWithFolderMatch ? "error" : parsed.matchStatus,
            reportStudentName: parsed.reportStudentName,
            reportStudentId: parsed.reportStudentId,
            matchedStudentId: parsed.matchedStudentId,
            matchedStudentName: parsed.matchedStudentName,
            evidence: parsed.evidence,
            error: conflictsWithFolderMatch
              ? `文件名预匹配为${expected.studentName}，但报告内容属于${parsed.matchedStudentName || "其他学生"}`
              : parsed.warning ?? "",
          } : item));
        } catch (error) {
          setItems((current) => current.map((item) => item.id === itemId ? {
            ...item,
            status: "error",
            error: errorMessage(error, "解析失败"),
          } : item));
        }
      }
    }

    try {
      await Promise.all(Array.from(
        { length: Math.min(2, selectedFiles.length) },
        () => worker(),
      ));
      input.setStatus(completionMessage || `已完成 ${selectedFiles.length} 份报告解析；请确认自动匹配结果。`);
      input.onInputsChanged();
    } finally {
      setBusy(false);
    }
  }

  async function importPdfs(files: FileList | File[] | null) {
    const selectedFiles = Array.from(files || [])
      .filter((file) => file.name.toLocaleLowerCase().endsWith(".pdf"));
    if (!selectedFiles.length) { input.setError("请选择 PDF 文件"); return; }
    if (!input.sessionCode) { input.setError("请先选择课次，再导入出门测报告"); return; }
    setFolderPlan(null);
    await processPdfs(selectedFiles);
  }

  async function importFolder(files: FileList | File[] | null) {
    const selectedFiles = Array.from(files || []);
    if (!input.sessionCode) { input.setError("请先选择课次，再选择报告文件夹"); return; }
    if (!input.students.length) { input.setError("当前课次还没有可匹配的学生名单"); return; }
    const plan = planAssessmentFolderImport(selectedFiles, input.students);
    setFolderPlan(plan);
    input.setError("");
    if (!plan.totalPdfCount) {
      input.setError("所选文件夹中没有 PDF 文件");
      return;
    }
    if (!plan.matched.length) {
      input.setStatus(`已检查文件夹，但没有 PDF 文件名能匹配当前班级的 ${input.students.length} 名学生。`);
      return;
    }
    const matchedFiles = plan.matched.map((match) => selectedFiles[match.fileIndex]);
    input.setStatus(
      `已完成名单预匹配：命中 ${plan.matched.length} 人，缺少 ${plan.missingStudents.length} 人；开始两份并发解析。`,
    );
    await processPdfs(
      matchedFiles,
      plan.matched.map((match) => ({
        studentId: match.studentId,
        studentName: match.studentName,
      })),
      `文件夹处理完成：已解析 ${plan.matched.length} 份；缺少 ${plan.missingStudents.length} 人，额外文件已忽略。`,
    );
  }

  function matchItem(itemId: string, studentId: string) {
    const student = input.students.find((item) => item.id === studentId);
    setItems((current) => current.map((item) => item.id === itemId ? {
      ...item,
      status: student ? "matched" : "needs_match",
      matchedStudentId: student?.id ?? "",
      matchedStudentName: student?.name ?? "",
      evidence: item.evidence && student ? {
        ...item.evidence,
        sessionCode: input.sessionCode,
        studentId: student.id,
      } : item.evidence,
      error: student ? "" : "请选择学生",
    } : item));
  }

  function confirmItem(itemId: string) {
    setItems((current) => {
      const target = current.find((item) => item.id === itemId);
      if (!target?.matchedStudentId || !target.evidence) return current;
      const duplicate = current.some((item) => (
        item.id !== itemId
        && item.status === "confirmed"
        && item.matchedStudentId === target.matchedStudentId
      ));
      return current.map((item) => item.id === itemId ? {
        ...item,
        status: duplicate ? "error" : "confirmed",
        error: duplicate ? `${target.matchedStudentName} 已有一份已确认报告，请先移除旧报告` : "",
      } : item);
    });
    input.onInputsChanged();
  }

  function confirmAllMatches() {
    setItems((current) => {
      const seen = new Set(current
        .filter((item) => item.status === "confirmed")
        .map((item) => item.matchedStudentId));
      return current.map((item) => {
        if (item.status !== "matched" || !item.matchedStudentId || !item.evidence) return item;
        if (seen.has(item.matchedStudentId)) {
          return {
            ...item,
            status: "error",
            error: `${item.matchedStudentName} 存在重复报告，请保留一份`,
          };
        }
        seen.add(item.matchedStudentId);
        return { ...item, status: "confirmed", error: "" };
      });
    });
    input.setStatus("已批量确认自动匹配结果。");
    input.onInputsChanged();
  }

  function removeItem(itemId: string) {
    setItems((current) => current.filter((item) => item.id !== itemId));
    input.onInputsChanged();
  }

  function removeFailed() {
    setItems((current) => current.filter((item) => item.status !== "error"));
    input.setStatus("已批量移除解析失败或重复的报告。");
  }

  function clear() {
    setItems([]);
    setFolderPlan(null);
    input.setStatus("出门测报告已清空。");
    input.onInputsChanged();
  }

  function replaceItems(nextItems: AssessmentImportItem[]) {
    setItems(nextItems);
    setFolderPlan(null);
  }

  return {
    items,
    setItems: replaceItems,
    folderPlan,
    busy,
    evidenceByStudent,
    confirmedCount: items.filter((item) => item.status === "confirmed").length,
    readyCount: items.filter((item) => item.status === "matched").length,
    attentionCount: items.filter((item) => item.status === "needs_match" || item.status === "error").length,
    importPdfs,
    importFolder,
    matchItem,
    confirmItem,
    confirmAllMatches,
    removeItem,
    removeFailed,
    clear,
  };
}
