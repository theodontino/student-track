"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTeachingContext } from "@/features/teaching-context";
import { requestJson } from "@/lib/api-client";
import { filterStudents, groupStudentsByClass } from "./student-list-utils";
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

export function useStudentsWorkspace() {
  const router = useRouter();
  const { context, hydrated, setSemesterId } = useTeachingContext();
  const selectedSemesterId = context.semesterId;
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

  const fetchStudents = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const query = new URLSearchParams({ semesterSummary: "true" });
      if (selectedSemesterId) query.set("semesterId", selectedSemesterId);
      const data = await requestJson<StudentListItem[]>(`/api/students?${query}`);
      setStudents(data);
      const resolvedSemesterId = data.find((student) => student.semesterSummary)?.semesterSummary?.semester.id;
      if (!selectedSemesterId && resolvedSemesterId) setSemesterId(resolvedSemesterId);
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
    () => filterStudents(students, search),
    [search, students],
  );
  const classGroups = useMemo(
    () => groupStudentsByClass(filteredStudents),
    [filteredStudents],
  );
  const selectedStudent = useMemo(
    () => students.find((student) => student.id === selectedStudentId) ?? null,
    [selectedStudentId, students],
  );

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
    setSubmitting(true);
    setFormError("");
    try {
      const url = editingStudent ? `/api/students/${editingStudent.id}` : "/api/students";
      await requestJson<StudentListItem>(url, {
        method: editingStudent ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
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
      if (selectedStudentId === deleteTarget.id) setSelectedStudentId("");
      setDeleteTarget(null);
      await fetchStudents();
    } catch (reason) {
      setDeleteError(reason instanceof Error ? reason.message : "删除学生失败");
    } finally {
      setDeleting(false);
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
    if (!importFile) return;
    setImporting(true);
    setImportResult(null);
    try {
      const formData = new FormData();
      formData.append("file", importFile);
      const result = await requestJson<StudentImportResult>("/api/students/import", {
        method: "POST",
        body: formData,
      });
      setImportResult(result);
      setImportFile(null);
      await fetchStudents();
    } catch (reason) {
      setImportResult({ error: reason instanceof Error ? reason.message : "导入失败" });
    } finally {
      setImporting(false);
    }
  }

  function openStudent(studentId: string) {
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
    search,
    selectedStudent,
    selectedSemesterId,
    selectStudent: setSelectedStudentId,
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
