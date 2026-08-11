"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTeachingContext } from "@/features/teaching-context/use-teaching-context";
import { useClasses } from "@/features/teaching-context/use-options";
import { requestJson } from "@/lib/api-client";
import { filterStudents, groupStudentsByClass, sortStudents, type StudentSort } from "./student-list-utils";
import type {
  StudentFormState,
  StudentImportResult,
  StudentListItem,
} from "./types";

const EMPTY_FORM: StudentFormState = {
  name: "",
  classCode: "",
  studentId: "",
  gender: "男",
  labelNames: [],
};
const STUDENT_PREVIEW_DELAY_MS = 120;

export function useStudentsWorkspace() {
  const router = useRouter();
  const { context, hydrated, setSemesterId } = useTeachingContext();
  const selectedSemesterId = context.semesterId;
  const semesterClasses = useClasses(selectedSemesterId);
  const [students, setStudents] = useState<StudentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [collapsedClasses, setCollapsedClasses] = useState<Set<string>>(new Set());
  const [showStudentDialog, setShowStudentDialog] = useState(false);
  const [editingStudent, setEditingStudent] = useState<StudentListItem | null>(null);
  const [form, setForm] = useState<StudentFormState>(EMPTY_FORM);
  const [labelInput, setLabelInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<StudentImportResult | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<StudentListItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [selectedStudentId, setSelectedStudentId] = useState("");
  const [previewPhase, setPreviewPhase] = useState<"idle" | "entering" | "visible" | "exiting">("idle");
  const [sort, setSort] = useState<StudentSort>("score-desc");
  const [rosterFilter, setRosterFilter] = useState<"all" | "active" | "inactive">("all");
  const [statusUpdatingId, setStatusUpdatingId] = useState("");
  const [transferTarget, setTransferTarget] = useState<StudentListItem | null>(null);
  const [transferClassId, setTransferClassId] = useState("");
  const [transferring, setTransferring] = useState(false);
  const [transferError, setTransferError] = useState("");
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeGraceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const animationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchStudents = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const query = new URLSearchParams({ semesterSummary: "true" });
      if (selectedSemesterId) query.set("semesterId", selectedSemesterId);
      const data = await requestJson<StudentListItem[]>(`/api/students?${query}`);
      setStudents(data);
      const resolvedSemesterId = data.find((student) => student.semesterSummary)?.semesterSummary?.semester.id;
      if (!selectedSemesterId) {
        if (resolvedSemesterId) setSemesterId(resolvedSemesterId);
        else {
          const semesters = await requestJson<Array<{ id: string }>>("/api/semesters");
          if (semesters[0]?.id) setSemesterId(semesters[0].id);
        }
      }
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : "获取学生列表失败");
    } finally {
      setLoading(false);
    }
  }, [selectedSemesterId, setSemesterId]);

  useEffect(() => {
    if (hydrated) void fetchStudents();
  }, [fetchStudents, hydrated]);

  const filteredStudents = useMemo(
    () => sortStudents(filterStudents(students.filter((student) => (
      rosterFilter === "all"
      || (rosterFilter === "active" && student.rosterStatus === "ACTIVE")
      || (rosterFilter === "inactive" && student.rosterStatus === "INACTIVE")
    )), search), sort),
    [rosterFilter, search, sort, students],
  );
  const classGroups = useMemo(
    () => groupStudentsByClass(filteredStudents),
    [filteredStudents],
  );
  const selectedStudent = useMemo(
    () => students.find((student) => student.id === selectedStudentId) ?? null,
    [selectedStudentId, students],
  );

  useEffect(() => () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (closeGraceTimer.current) clearTimeout(closeGraceTimer.current);
    if (animationTimer.current) clearTimeout(animationTimer.current);
  }, []);

  function clearPreviewTimers() {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (closeGraceTimer.current) clearTimeout(closeGraceTimer.current);
    if (animationTimer.current) clearTimeout(animationTimer.current);
    hoverTimer.current = null;
    closeGraceTimer.current = null;
    animationTimer.current = null;
  }

  function showStudentPreview(studentId: string) {
    if (closeGraceTimer.current) clearTimeout(closeGraceTimer.current);
    if (animationTimer.current) clearTimeout(animationTimer.current);
    closeGraceTimer.current = null;
    animationTimer.current = null;
    setSelectedStudentId(studentId);
    setPreviewPhase("entering");
    animationTimer.current = setTimeout(() => {
      setPreviewPhase("visible");
      animationTimer.current = null;
    }, 220);
  }

  function beginStudentPreview(studentId: string) {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (closeGraceTimer.current) clearTimeout(closeGraceTimer.current);
    closeGraceTimer.current = null;
    if (selectedStudentId === studentId && previewPhase !== "exiting") return;
    hoverTimer.current = setTimeout(() => {
      showStudentPreview(studentId);
      hoverTimer.current = null;
    }, STUDENT_PREVIEW_DELAY_MS);
  }

  function keepStudentPreview() {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (closeGraceTimer.current) clearTimeout(closeGraceTimer.current);
    hoverTimer.current = null;
    closeGraceTimer.current = null;
    if (selectedStudentId && previewPhase === "exiting") showStudentPreview(selectedStudentId);
  }

  function closeStudentPreview() {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (closeGraceTimer.current) clearTimeout(closeGraceTimer.current);
    hoverTimer.current = null;
    closeGraceTimer.current = null;
    if (!selectedStudentId) return;
    if (animationTimer.current) clearTimeout(animationTimer.current);
    setPreviewPhase("exiting");
    animationTimer.current = setTimeout(() => {
      setSelectedStudentId("");
      setPreviewPhase("idle");
      animationTimer.current = null;
    }, 180);
  }

  function endStudentPreview() {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    if (closeGraceTimer.current) clearTimeout(closeGraceTimer.current);
    closeGraceTimer.current = setTimeout(() => {
      closeGraceTimer.current = null;
      closeStudentPreview();
    }, 140);
  }

  function toggleClass(className: string) {
    setCollapsedClasses((current) => {
      const next = new Set(current);
      if (next.has(className)) next.delete(className);
      else next.add(className);
      return next;
    });
  }

  function openCreate() {
    setEditingStudent(null);
    setForm(EMPTY_FORM);
    setLabelInput("");
    setFormError("");
    setShowStudentDialog(true);
  }

  function openEdit(student: StudentListItem) {
    setEditingStudent(student);
    setForm({
      name: student.name,
      classCode: student.classCode || student.class,
      studentId: student.studentId,
      gender: student.gender,
      labelNames: student.labels.map((label) => label.name),
    });
    setLabelInput("");
    setFormError("");
    setShowStudentDialog(true);
  }

  function closeStudentDialog() {
    if (!submitting) setShowStudentDialog(false);
  }

  function addLabel(label = labelInput) {
    const normalized = label.trim();
    if (normalized && !form.labelNames.includes(normalized)) {
      setForm((current) => ({ ...current, labelNames: [...current.labelNames, normalized] }));
    }
    setLabelInput("");
  }

  function removeLabel(label: string) {
    setForm((current) => ({
      ...current,
      labelNames: current.labelNames.filter((item) => item !== label),
    }));
  }

  async function submitStudent() {
    if (!selectedSemesterId) {
      setFormError("请先选择学期");
      return;
    }
    setSubmitting(true);
    setFormError("");
    try {
      const url = editingStudent ? `/api/students/${editingStudent.id}` : "/api/students";
      const payload = editingStudent
        ? { name: form.name, studentId: form.studentId, gender: form.gender, labelNames: form.labelNames, semesterId: selectedSemesterId }
        : { ...form, semesterId: selectedSemesterId };
      await requestJson<StudentListItem>(url, {
        method: editingStudent ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setShowStudentDialog(false);
      await fetchStudents();
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "保存学生失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await requestJson<{ success: true }>(`/api/students/${deleteTarget.id}`, { method: "DELETE" });
      if (selectedStudentId === deleteTarget.id) {
        clearPreviewTimers();
        setSelectedStudentId("");
        setPreviewPhase("idle");
      }
      setDeleteTarget(null);
      await fetchStudents();
    } catch (reason) {
      setDeleteError(reason instanceof Error ? reason.message : "删除学生失败");
    } finally {
      setDeleting(false);
    }
  }

  async function setRosterStatus(student: StudentListItem, status: "active" | "inactive") {
    setStatusUpdatingId(student.id);
    setLoadError("");
    try {
      await requestJson(`/api/students/${student.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, semesterId: selectedSemesterId }),
      });
      await fetchStudents();
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : "更新学生状态失败");
    } finally {
      setStatusUpdatingId("");
    }
  }

  function openTransfer(student: StudentListItem) {
    setTransferTarget(student);
    setTransferClassId("");
    setTransferError("");
  }

  function closeTransfer() {
    if (transferring) return;
    setTransferTarget(null);
    setTransferClassId("");
    setTransferError("");
  }

  async function submitTransfer() {
    if (!transferTarget) return;
    if (!selectedSemesterId) {
      setTransferError("请先选择学期");
      return;
    }
    if (!transferClassId) {
      setTransferError("请选择目标班级");
      return;
    }
    if (transferClassId === transferTarget.classId) {
      setTransferError("目标班级与当前班级相同");
      return;
    }
    setTransferring(true);
    setTransferError("");
    try {
      await requestJson(`/api/students/${transferTarget.id}/enrollment`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ semesterId: selectedSemesterId, classId: transferClassId }),
      });
      setTransferTarget(null);
      setTransferClassId("");
      await fetchStudents();
    } catch (reason) {
      setTransferError(reason instanceof Error ? reason.message : "转班失败");
    } finally {
      setTransferring(false);
    }
  }

  function openImport() {
    setImportFile(null);
    setImportResult(null);
    setShowImportDialog(true);
  }

  function closeImport() {
    if (importing) return;
    setShowImportDialog(false);
    setImportFile(null);
    setImportResult(null);
  }

  async function importStudents() {
    if (!importFile || !selectedSemesterId) {
      setImportResult({ error: "请先选择学期和文件" });
      return;
    }
    setImporting(true);
    setImportResult(null);
    try {
      const formData = new FormData();
      formData.append("file", importFile);
      formData.append("semesterId", selectedSemesterId);
      if (importResult?.mode === "preview" && importResult.fingerprint) {
        formData.append("mode", "confirm");
        formData.append("previewFingerprint", importResult.fingerprint);
        if (importResult.semesterId) formData.append("previewSemesterId", importResult.semesterId);
      }
      const result = await requestJson<StudentImportResult>("/api/students/import", {
        method: "POST",
        body: formData,
      });
      setImportResult(result);
      if (result.mode === "committed") setImportFile(null);
      await fetchStudents();
    } catch (reason) {
      setImportResult({ error: reason instanceof Error ? reason.message : "导入失败" });
    } finally {
      setImporting(false);
    }
  }

  function openStudent(studentId: string) {
    // A list-row click can blur the active preview in WebKit before navigation
    // settles. Cancel that asynchronous transition so it cannot compete with
    // the route change.
    clearPreviewTimers();
    setSelectedStudentId("");
    setPreviewPhase("idle");
    const query = selectedSemesterId
      ? `?semesterId=${encodeURIComponent(selectedSemesterId)}`
      : "";
    router.push(`/students/${studentId}${query}`);
  }

  return {
    addLabel,
    classGroups,
    closeImport,
    closeStudentDialog,
    collapsedClasses,
    confirmDelete,
    deleteError,
    deleteTarget,
    deleting,
    editingStudent,
    fetchStudents,
    filteredStudents,
    form,
    formError,
    hydrated,
    importFile,
    importResult,
    importing,
    importStudents,
    labelInput,
    loadError,
    loading,
    openCreate,
    openEdit,
    openImport,
    openStudent,
    removeLabel,
    rosterFilter,
    search,
    setRosterFilter,
    setRosterStatus,
    sort,
    statusUpdatingId,
    semesterClasses,
    openTransfer,
    closeTransfer,
    submitTransfer,
    transferTarget,
    transferClassId,
    setTransferClassId,
    transferError,
    transferring,
    setSort,
    selectedStudent,
    previewPhase,
    selectedSemesterId,
    beginStudentPreview,
    showStudentPreview,
    keepStudentPreview,
    endStudentPreview,
    closeStudentPreview,
    setDeleteError,
    setDeleteTarget,
    setForm,
    setImportFile,
    setImportResult,
    setLabelInput,
    setSearch,
    setSemesterId,
    showImportDialog,
    showStudentDialog,
    students,
    submitStudent,
    submitting,
    toggleClass,
  };
}
