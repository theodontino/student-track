"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, ErrorState, GlowSurface, LoadingState, Section } from "@/components/ui";
import TeacherObservationsPanel from "@/features/reports/TeacherObservationsPanel";
import type { ObservationStatus, TeacherObservationView } from "@/lib/contracts/teaching-summary";
import { requestJson } from "@/lib/api-client";

export default function DashboardTeacherObservations({ semesterId }: { semesterId?: string }) {
  const [items, setItems] = useState<TeacherObservationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ status: "new,read,deferred", limit: "100" });
      if (semesterId) params.set("semesterId", semesterId);
      setItems(await requestJson<TeacherObservationView[]>(`/api/teacher-observations?${params}`));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取家校沟通观察失败");
    } finally {
      setLoading(false);
    }
  }, [semesterId]);

  useEffect(() => { void load(); }, [load]);

  async function changeStatus(id: string, status: ObservationStatus) {
    const updated = await requestJson<TeacherObservationView>(`/api/teacher-observations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    setItems((current) => (
      ["handled", "ignored"].includes(updated.status)
        ? current.filter((item) => item.id !== updated.id)
        : current.map((item) => item.id === updated.id ? updated : item)
    ));
  }

  return <GlowSurface tone="attention" active={items.length > 0} className="dashboard-risk-glow dashboard-risk-glow--attention dashboard-teacher-observations">
    <Section
      className="dashboard-risk-section dashboard-risk-section--attention"
      title="家校沟通观察"
      description="教师内部待办；独立于警告、持续关注和考勤计数"
      actions={<Badge tone={items.some((item) => item.status === "new") ? "warning" : "neutral"}>{items.length} 项</Badge>}
    >
      <div className="p-4">
        {loading
          ? <LoadingState label="正在读取沟通观察…" />
          : error
            ? <ErrorState message={error} />
            : <TeacherObservationsPanel items={items} onStatusChange={changeStatus} compact />}
      </div>
    </Section>
  </GlowSurface>;
}
