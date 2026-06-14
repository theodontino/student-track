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
  labels: { id: string; name: string }[];
  scores?: { scoreA: number; scoreB: number; scoreC: number; scoreD: number } | null;
  createdAt: string;
  updatedAt: string;
}

interface ImportResult {
  success?: boolean;
  total?: number;
  successCount?: number;
  errorCount?: number;
  errors?: string[];
  error?: string;
}

const PRESET_TAGS = [
  "#逻辑强", "#基础弱", "#主动", "#被动", "#调皮",
  "#敏感", "#内向", "#外向", "#注意力差", "#爱发言",
];

export default function StudentsPage() {
  const router = useRouter();
  const [students, setStudents] = useState<Student[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [collapsedClasses, setCollapsedClasses] = useState<Set<string>>(new Set());
  const [showModal, setShowModal] = useState(false);
  const [editingStudent, setEditingStudent] = useState<Student | null>(null);
  const [form, setForm] = useState({ name: "", classCode: "", studentId: "", gender: "男", labelNames: [] as string[] });
  const [labelInput, setLabelInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  useEffect(() => { fetchStudents(); }, []);

  async function fetchStudents() {
    try {
      const res = await fetch("/api/students?summary=true");
      const data = await res.json();
      setStudents(data);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  }

  function toggleClass(cls: string) {
    setCollapsedClasses((prev) => {
      const next = new Set(prev);
      if (next.has(cls)) {
        next.delete(cls);
      } else {
        next.add(cls);
      }
      return next;
    });
  }

  // Filter by name / studentId / label
  const filtered = students.filter((s) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      s.name.includes(q) ||
      s.studentId.toLowerCase().includes(q) ||
      s.labels.some((l) => l.name.toLowerCase().includes(q)) ||
      s.class.toLowerCase().includes(q)
    );
  });

  // Group by class
  const classGroups = new Map<string, Student[]>();
  for (const s of filtered) {
    const arr = classGroups.get(s.class) || [];
    arr.push(s);
    classGroups.set(s.class, arr);
  }

  // -- Form handlers --
  function openCreate() {
    setEditingStudent(null);
    setForm({ name: "", classCode: "", studentId: "", gender: "男", labelNames: [] });
    setLabelInput(""); setError(""); setShowModal(true);
  }
  function openEdit(s: Student) {
    setEditingStudent(s);
    setForm({ name: s.name, classCode: s.classCode || s.class, studentId: s.studentId, gender: s.gender, labelNames: s.labels.map((l) => l.name) });
    setLabelInput(""); setError(""); setShowModal(true);
  }
  function addLabel() {
    const t = labelInput.trim();
    if (t && !form.labelNames.includes(t)) setForm({ ...form, labelNames: [...form.labelNames, t] });
    setLabelInput("");
  }
  function removeLabel(label: string) {
    setForm({ ...form, labelNames: form.labelNames.filter((l) => l !== label) });
  }
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault(); setSubmitting(true); setError("");
    try {
      const url = editingStudent ? `/api/students/${editingStudent.id}` : "/api/students";
      const method = editingStudent ? "PUT" : "POST";
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || "操作失败"); }
      setShowModal(false); fetchStudents();
    } catch (e: any) { setError(e.message); }
    finally { setSubmitting(false); }
  }
  async function handleDelete(id: string, name: string) {
    if (!confirm(`确定删除 ${name}？将同时删除所有评分、事件和沟通记录。`)) return;
    await fetch(`/api/students/${id}`, { method: "DELETE" });
    fetchStudents();
  }

  function openImport() {
    setImportFile(null);
    setImportResult(null);
    setShowImport(true);
  }

  function closeImport() {
    if (importing) return;
    setShowImport(false);
    setImportFile(null);
    setImportResult(null);
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
      const data = await res.json() as ImportResult;
      if (!res.ok) throw new Error(data.error || "导入失败");

      setImportResult(data);
      setImportFile(null);
      await fetchStudents();
    } catch (err) {
      setImportResult({ error: err instanceof Error ? err.message : "导入失败" });
    } finally {
      setImporting(false);
    }
  }

  // -- Score mini bar --
  function ScoreBar({ score, color }: { score: number; color: string }) {
    return <div className="flex items-center gap-1"><div className="w-8 h-1.5 rounded-full bg-gray-100"><div className={`h-full rounded-full ${color}`} style={{ width: `${(score / 5) * 100}%` }} /></div><span className="text-[10px] font-mono text-gray-500 w-3 text-right">{score}</span></div>;
  }

  if (loading) return <div className="text-center py-20 text-gray-400">加载中...</div>;

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold text-gray-800">学生管理</h2>
        <div className="flex items-center gap-2">
          <button onClick={openImport}
            className="border border-gray-300 text-gray-600 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50">
            📥 导入花名册
          </button>
          <button onClick={openCreate} className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700">+ 添加学生</button>
        </div>
      </div>

      {/* Search */}
      <div className="mb-6">
        <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="按姓名、学号、标签或班级搜索..."
          className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-500"
        />
        {search && (
          <p className="text-xs text-gray-400 mt-1">{filtered.length} / {students.length} 名学生匹配</p>
        )}
      </div>

      {/* Class groups */}
      {[...classGroups.entries()].map(([cls, stus]) => {
        const collapsed = collapsedClasses.has(cls);
        return (
          <div key={cls} className="mb-4">
            <div className="flex items-center justify-between mb-2 cursor-pointer select-none"
              onClick={() => toggleClass(cls)}>
              <h3 className="text-sm font-semibold text-gray-700">
                {cls} <span className="text-gray-400 font-normal">({stus.length}人)</span>
              </h3>
              <span className="text-xs text-gray-400">{collapsed ? "展开 ▸" : "收起 ▾"}</span>
            </div>

            {!collapsed && (
              <div className="space-y-2">
                {stus.map((s) => (
                  <div key={s.id} onClick={() => router.push(`/students/${s.id}`)}
                    className="bg-white rounded-lg border border-gray-200 p-4 flex items-center gap-4 hover:shadow-sm transition-shadow cursor-pointer">
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-semibold ${s.gender === "男" ? "bg-blue-500" : "bg-pink-500"}`}>
                      {s.name[0]}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-800 text-sm">{s.name}</span>
                        <span className="text-xs text-gray-400">{s.studentId}</span>
                      </div>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {s.labels.map((l) => (
                          <span key={l.id} className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">{l.name}</span>
                        ))}
                      </div>
                    </div>
                    {s.scores && (
                      <div className="hidden sm:flex items-center gap-2">
                        <ScoreBar score={s.scores.scoreA} color="bg-blue-400" />
                        <ScoreBar score={s.scores.scoreB} color="bg-green-400" />
                        <ScoreBar score={s.scores.scoreC} color="bg-amber-400" />
                        <ScoreBar score={s.scores.scoreD} color="bg-purple-400" />
                      </div>
                    )}
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={(e) => { e.stopPropagation(); openEdit(s); }}
                        className="text-sm text-gray-400 hover:text-blue-600 px-2">编辑</button>
                      <button onClick={(e) => { e.stopPropagation(); handleDelete(s.id, s.name); }}
                        className="text-sm text-gray-400 hover:text-red-600 px-2">删除</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {!loading && students.length === 0 && (
        <div className="text-center py-20 text-gray-400"><p className="text-4xl mb-3">📋</p><p>还没有添加学生</p></div>
      )}

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center">
          <div className="bg-white rounded-xl w-full max-w-md p-6 shadow-xl">
            <h3 className="text-lg font-bold text-gray-800 mb-4">{editingStudent ? "编辑学生" : "添加学生"}</h3>
            {error && <div className="mb-4 p-3 bg-red-50 text-red-600 text-sm rounded-lg">{error}</div>}
            <form onSubmit={handleSubmit} className="space-y-4">
              <div><label className="block text-sm font-medium text-gray-700 mb-1">姓名 *</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none" required /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="block text-sm font-medium text-gray-700 mb-1">班级编号 *</label><input value={form.classCode} onChange={(e) => setForm({ ...form, classCode: e.target.value })} placeholder="如：G3-01" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none" required /></div>
                <div><label className="block text-sm font-medium text-gray-700 mb-1">学号 *</label><input value={form.studentId} onChange={(e) => setForm({ ...form, studentId: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none" required /></div>
              </div>
              <div><label className="block text-sm font-medium text-gray-700 mb-1">性别</label><select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none"><option value="男">男</option><option value="女">女</option></select></div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">标签</label>
                <div className="flex gap-2"><input value={labelInput} onChange={(e) => setLabelInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addLabel(); } }} placeholder="输入标签后回车添加" className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none" /><button type="button" onClick={addLabel} className="px-3 py-2 bg-gray-100 text-gray-600 rounded-lg text-sm hover:bg-gray-200">添加</button></div>
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {PRESET_TAGS.filter((t) => !form.labelNames.includes(t)).map((tag) => (
                    <button key={tag} type="button" onClick={() => { if (!form.labelNames.includes(tag)) setForm({ ...form, labelNames: [...form.labelNames, tag] }); }} className="text-xs bg-gray-50 text-gray-500 px-2 py-0.5 rounded border border-gray-200 hover:bg-blue-50 hover:text-blue-600">{tag}</button>
                  ))}
                </div>
                {form.labelNames.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">{form.labelNames.map((l) => (<span key={l} className="inline-flex items-center gap-1 text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded">{l}<button type="button" onClick={() => removeLabel(l)} className="hover:text-red-500">×</button></span>))}</div>
                )}
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowModal(false)} className="flex-1 py-2 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50">取消</button>
                <button type="submit" disabled={submitting} className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">{submitting ? "保存中..." : "保存"}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showImport && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-xl w-full max-w-md p-6 shadow-xl">
            <h3 className="text-lg font-bold text-gray-800 mb-4">导入花名册</h3>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4 text-xs text-blue-700">
              <p className="font-medium mb-1">支持 .xlsx / .csv 文件，表头需包含：</p>
              <code className="text-blue-600">姓名, 班级, 学号, 性别(选填)</code>
            </div>

            <input
              key={importFile ? "selected" : "empty"}
              type="file"
              accept=".xlsx,.csv"
              disabled={importing}
              onChange={(e) => {
                setImportFile(e.target.files?.[0] || null);
                setImportResult(null);
              }}
              className="w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 disabled:opacity-50"
            />

            {importResult?.success && (
              <div className="mt-4 bg-green-50 border border-green-200 rounded-lg p-3 text-xs text-green-700">
                成功导入 {importResult.successCount} / {importResult.total} 名学生
                {(importResult.errorCount ?? 0) > 0 && (
                  <div className="mt-2 text-red-600">
                    <p>{importResult.errorCount} 条失败：</p>
                    {importResult.errors?.map((message, index) => <div key={index}>{message}</div>)}
                  </div>
                )}
              </div>
            )}

            {importResult?.error && (
              <div className="mt-4 bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-600">
                {importResult.error}
              </div>
            )}

            <div className="flex gap-3 mt-5">
              <button type="button" onClick={closeImport} disabled={importing}
                className="flex-1 py-2 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50">
                {importResult?.success ? "完成" : "取消"}
              </button>
              <button type="button" onClick={handleImport} disabled={!importFile || importing}
                className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
                {importing ? "导入中..." : "开始导入"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
