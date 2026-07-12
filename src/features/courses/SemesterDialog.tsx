"use client";

import { useEffect, useState } from "react";
import { Button, Dialog, Input, StatusBanner } from "@/components/ui";
import { requestJson } from "@/lib/api-client";
import type { SemesterSummary } from "@/features/teaching-context";

export function SemesterDialog({ open, semester, onClose, onSaved }: { open: boolean; semester?: SemesterSummary | null; onClose: () => void; onSaved: (semester: SemesterSummary) => void }) {
  const [form, setForm] = useState({ name: "", startDate: "", endDate: "" }); const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  useEffect(() => setForm({ name: semester?.name ?? "", startDate: semester?.startDate ?? "", endDate: semester?.endDate ?? "" }), [semester, open]);
  async function submit(event: React.FormEvent) { event.preventDefault(); setSaving(true); setError(""); try { const saved = await requestJson<SemesterSummary>(semester ? `/api/semesters/${semester.id}` : "/api/semesters", { method: semester ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) }); onSaved(saved); onClose(); } catch (reason) { setError(reason instanceof Error ? reason.message : "保存学期失败"); } finally { setSaving(false); } }
  return <Dialog open={open} title={semester ? "编辑学期" : "新建学期"} onClose={onClose}><form onSubmit={submit} className="dialog-form">{error && <StatusBanner tone="danger">{error}</StatusBanner>}<label>学期名称<Input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label><div className="dialog-form__row"><label>开始日期<Input required type="date" value={form.startDate} onChange={(event) => setForm({ ...form, startDate: event.target.value })} /></label><label>结束日期<Input required type="date" value={form.endDate} onChange={(event) => setForm({ ...form, endDate: event.target.value })} /></label></div><div className="dialog-form__actions"><Button variant="secondary" onClick={onClose}>取消</Button><Button type="submit" disabled={saving}>{saving ? "保存中…" : "保存学期"}</Button></div></form></Dialog>;
}
