"use client";

import { Select } from "@/components/ui";
import { useSemesters } from "./use-options";

export function SemesterContextSelector({
  value,
  onChange,
  label = "查看学期",
  compact = false,
}: {
  value: string;
  onChange: (semesterId: string) => void;
  label?: string;
  compact?: boolean;
}) {
  const semesters = useSemesters();
  return (
    <label className={`block ${compact ? "min-w-44" : "min-w-52"} text-xs font-semibold text-gray-500`}>
      {label}
      <Select className="mt-1" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">当前学期</option>
        {semesters.map((semester) => <option key={semester.id} value={semester.id}>{semester.name}</option>)}
      </Select>
    </label>
  );
}
