export interface SystemLogEntry {
  id: string;
  action: string;
  targetType: string;
  targetId: string | null;
  targetName: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface SystemLogsResponse {
  logs: SystemLogEntry[];
  total: number;
}

export const ACTION_LABELS: Record<string, string> = {
  "score.updated": "评分更新",
  "alert.triggered": "预警触发",
  "student.deleted": "学生删除",
  "session.created": "课次创建",
  "session.deleted": "课次删除",
  "data.exported": "数据导出",
};

export const TARGET_LABELS: Record<string, string> = {
  Student: "学生",
  Session: "课次",
  Draft: "草案",
  Class: "班级",
  System: "系统",
};

export function formatLogDetail(detail: Record<string, unknown>) {
  if (!detail || Object.keys(detail).length === 0) return "—";
  return Object.entries(detail)
    .map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`)
    .join(" | ");
}
