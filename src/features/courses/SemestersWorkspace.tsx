"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button, PageHeader } from "@/components/ui";
import { SemesterDialog } from "./SemesterDialog";

interface Semester {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  sessionCount: number;
}

export default function SemestersWorkspace() {
  const router = useRouter();
  const [semesters, setSemesters] = useState<Semester[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    fetch("/api/semesters")
      .then((r) => r.json())
      .then(setSemesters)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="text-center py-20 text-gray-400">加载中...</div>;
  }

  return (
    <div className="max-w-4xl mx-auto">
      <PageHeader title="学期 / 课次" description="管理教学周期并进入课次详情。" actions={<Button onClick={() => setDialogOpen(true)}>新建学期</Button>} />

      {semesters.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-gray-400">
          暂无学期
        </div>
      ) : (
        <div className="space-y-3">
          {semesters.map((sem) => (
            <div
              key={sem.id}
              onClick={() => router.push(`/semesters/${sem.id}`)}
              className="bg-white rounded-xl border border-gray-200 p-5 cursor-pointer hover:shadow-sm transition-shadow"
            >
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-gray-800">{sem.name}</h3>
                  <p className="text-xs text-gray-400 mt-1">
                    {sem.startDate} → {sem.endDate}
                  </p>
                </div>
                <div className="text-right">
                  <div className="text-xl font-bold text-blue-600">{sem.sessionCount}</div>
                  <div className="text-xs text-gray-400">课次</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <SemesterDialog open={dialogOpen} onClose={() => setDialogOpen(false)} onSaved={(semester) => setSemesters((current) => [semester as Semester, ...current])} />
    </div>
  );
}
