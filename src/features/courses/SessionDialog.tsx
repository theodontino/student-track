"use client";

import { useState } from "react";
import { Button, Dialog, Input, StatusBanner } from "@/components/ui";
import { requestJson } from "@/lib/api-client";
import type { SessionSummary } from "@/features/teaching-context";

export function SessionDialog({ open, semesterId, className, onClose, onSaved }: { open: boolean; semesterId: string; className: string; onClose: () => void; onSaved: (session: SessionSummary) => void }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10)); const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  async function submit(event: React.FormEvent) { event.preventDefault(); setSaving(true); setError(""); try { const session = await requestJson<SessionSummary>(`/api/semesters/${semesterId}/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ className, date }) }); onSaved(session); onClose(); } catch (reason) { setError(reason instanceof Error ? reason.message : "创建课次失败"); } finally { setSaving(false); } }
  return <Dialog open={open} title="新建课次" onClose={onClose}><form onSubmit={submit} className="dialog-form">{error && <StatusBanner tone="danger">{error}</StatusBanner>}<p className="dialog-form__hint">{className || "请先选择班级"}</p><label>上课日期<Input required type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label><div className="dialog-form__actions"><Button variant="secondary" onClick={onClose}>取消</Button><Button type="submit" disabled={saving || !semesterId || !className}>{saving ? "创建中…" : "创建课次"}</Button></div></form></Dialog>;
}
