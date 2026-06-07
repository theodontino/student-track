"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

interface Student {
  id: string;
  name: string;
  class: string;
  classCode: string;
  studentId: string;
  gender: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
}

// v0.5: 预设标签库，教师可快速点选
const PRESET_TAGS = [
  "#逻辑强", "#基础弱", "#主动", "#被动", "#调皮",
  "#敏感", "#内向", "#外向", "#注意力差", "#爱发言",
];

export default function StudentsPage() {
  const router = useRouter();
  const [students, setStudents] = useState<Student[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingStudent, setEditingStudent] = useState<Student | null>(null);

  const [form, setForm] = useState({
    name: "",
    classCode: "",
    studentId: "",
    gender: "男",
    labels: [] as string[],
  });
  const [labelInput, setLabelInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // Import state
  const [showImport, setShowImport] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<any>(null);

  useEffect(() => {
    fetchStudents();
  }, []);

  async function fetchStudents() {
    try {
      const res = await fetch("/api/students");
      const data = await res.json();
      setStudents(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  function openCreate() {
    setEditingStudent(null);
    setForm({ name: "", classCode: "", studentId: "", gender: "男", labels: [] });
    setLabelInput("");
    setError("");
    setShowModal(true);
  }

  function openEdit(s: Student) {
    setEditingStudent(s);
    setForm({
      name: s.name,
      classCode: s.classCode || s.class,
      studentId: s.studentId,
      gender: s.gender,
      labels: s.labels,
    });
    setLabelInput("");
    setError("");
    setShowModal(true);
  }

  function addLabel() {
    const trimmed = labelInput.trim();
    if (trimmed && !form.labels.includes(trimmed)) {
      setForm({ ...form, labels: [...form.labels, trimmed] });
    }
    setLabelInput("");
  }

  function removeLabel(label: string) {
    setForm({ ...form, labels: form.labels.filter((l) => l !== label) });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError("");

    try {
      const url = editingStudent
        ? `/api/students/${editingStudent.id}`
        : "/api/students";
      const method = editingStudent ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "操作失败");
      }

      setShowModal(false);
      fetchStudents();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleImport() {
    if (!importFile) return;
    setImporting(true);
    setImportResult(null);

    try {
      const formData = new FormData();
      formData.append("file", importFile);

      const res = await fetch("/api/students/import", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "导入失败");

      setImportResult(data);
      setImportFile(null);
      fetchStudents();
    } catch (err: any) {
      setImportResult({ error: err.message });
    } finally {
      setImporting(false);
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`确定要删除学生「${name}」吗？该操作不可撤销。`)) return;
    try {
      await fetch(`/api/students/${id}`, { method: "DELETE" });
      fetchStudents();
    } catch (err) {
      console.error(err);
    }
  }

  const classes = [...new Set(students.map((s) => s.class))];

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-800">学生管理</h2>
          <p className="text-sm text-gray-500 mt-1">
            共 {students.length} 名学生
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              setShowImport(true);
              setImportResult(null);
              setImportFile(null);
            }}
            className="border border-gray-300 text-gray-600 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors"
          >
            📥 导入花名册
          </button>
          <button
            onClick={openCreate}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            + 添加学生
          </button>
        </div>
      </div>

      {classes.map((cls) => (
        <div key={cls} className="mb-6">
          <h3 className="text-sm font-semibold text-gray-500 mb-2">{cls}</h3>
          <div className="grid gap-3">
            {students
              .filter((s) => s.class === cls)
              .map((s) => (
                <div
                  key={s.id}
                  className="bg-white rounded-lg border border-gray-200 p-4 flex items-center justify-between hover:shadow-sm transition-shadow cursor-pointer"
                  onClick={() => router.push(`/students/${s.id}`)}
                >
                  <div className="flex items-center gap-4">
                    <div
                      className={`w-10 h-10 rounded-full flex items-center justify-center text-white font-semibold text-sm ${
                        s.gender === "男" ? "bg-blue-500" : "bg-pink-500"
                      }`}
                    >
                      {s.name[0]}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-800">
                          {s.name}
                        </span>
                        <span className="text-xs text-gray-400">
                          {s.studentId}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {s.labels.map((label) => (
                          <span
                            key={label}
                            className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded"
                          >
                            {label}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        openEdit(s);
                      }}
                      className="text-sm text-gray-400 hover:text-blue-600 transition-colors px-2"
                    >
                      编辑
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(s.id, s.name);
                      }}
                      className="text-sm text-gray-400 hover:text-red-600 transition-colors px-2"
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))}
          </div>
        </div>
      ))}

      {!loading && students.length === 0 && (
        <div className="text-center py-20 text-gray-400">
          <p className="text-4xl mb-3">📋</p>
          <p>还没有添加学生</p>
          <button
            onClick={openCreate}
            className="text-blue-600 hover:underline mt-2"
          >
            立即添加
          </button>
        </div>
      )}

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center">
          <div className="bg-white rounded-xl w-full max-w-md p-6 shadow-xl">
            <h3 className="text-lg font-bold text-gray-800 mb-4">
              {editingStudent ? "编辑学生" : "添加学生"}
            </h3>
            {error && (
              <div className="mb-4 p-3 bg-red-50 text-red-600 text-sm rounded-lg">
                {error}
              </div>
            )}
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  姓名 *
                </label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    班级编号 *
                  </label>
                  <input
                    type="text"
                    value={form.classCode}
                    onChange={(e) =>
                      setForm({ ...form, classCode: e.target.value })
                    }
                    placeholder="如：G3-01"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    学号 *
                  </label>
                  <input
                    type="text"
                    value={form.studentId}
                    onChange={(e) =>
                      setForm({ ...form, studentId: e.target.value })
                    }
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                    required
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  性别
                </label>
                <select
                  value={form.gender}
                  onChange={(e) => setForm({ ...form, gender: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                >
                  <option value="男">男</option>
                  <option value="女">女</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  标签
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={labelInput}
                    onChange={(e) => setLabelInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addLabel();
                      }
                    }}
                    placeholder="输入标签后回车添加"
                    className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                  />
                  <button
                    type="button"
                    onClick={addLabel}
                    className="px-3 py-2 bg-gray-100 text-gray-600 rounded-lg text-sm hover:bg-gray-200"
                  >
                    添加
                  </button>
                </div>
                {/* v0.5: 预设标签建议 */}
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {PRESET_TAGS.filter((t) => !form.labels.includes(t)).map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => {
                        if (!form.labels.includes(tag)) {
                          setForm({ ...form, labels: [...form.labels, tag] });
                        }
                      }}
                      className="text-xs bg-gray-50 text-gray-500 px-2 py-0.5 rounded border border-gray-200 hover:bg-blue-50 hover:text-blue-600 hover:border-blue-200 transition-colors"
                    >
                      + {tag}
                    </button>
                  ))}
                </div>
                {form.labels.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {form.labels.map((label) => (
                      <span
                        key={label}
                        className="inline-flex items-center gap-1 text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded"
                      >
                        {label}
                        <button
                          type="button"
                          onClick={() => removeLabel(label)}
                          className="hover:text-red-500"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="flex-1 py-2 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
                >
                  {submitting ? "提交中..." : editingStudent ? "保存" : "创建"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Import Modal */}
      {showImport && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center">
          <div className="bg-white rounded-xl w-full max-w-md p-6 shadow-xl">
            <h3 className="text-lg font-bold text-gray-800 mb-4">导入花名册</h3>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4 text-xs text-blue-700">
              <p className="font-medium mb-1">支持 .xlsx / .csv 文件，表头需包含：</p>
              <code className="text-blue-600">姓名, 班级, 学号, 性别(选填)</code>
            </div>

            <input
              type="file"
              accept=".xlsx,.csv"
              onChange={(e) => {
                setImportFile(e.target.files?.[0] || null);
                setImportResult(null);
              }}
              className="w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
            />

            {importResult && !importResult.error && (
              <div className="mt-4 bg-green-50 border border-green-200 rounded-lg p-3 text-xs text-green-700">
                ✅ 成功导入 {importResult.successCount} / {importResult.total} 名学生
                {importResult.errorCount > 0 && (
                  <div className="mt-1 text-red-600">
                    {importResult.errorCount} 条失败：
                    {importResult.errors?.map((e: string, i: number) => (
                      <div key={i}>{e}</div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {importResult?.error && (
              <div className="mt-4 bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-600">
                {importResult.error}
              </div>
            )}

            <div className="flex gap-3 mt-4">
              <button
                onClick={() => {
                  setShowImport(false);
                  setImportResult(null);
                  setImportFile(null);
                }}
                className="flex-1 py-2 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50"
              >
                取消
              </button>
              <button
                onClick={handleImport}
                disabled={!importFile || importing}
                className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                {importing ? "导入中..." : "开始导入"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
