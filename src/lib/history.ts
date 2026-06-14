export type HistoryModule = "quick-score" | "input" | "report" | "export" | "feedback";

export interface WorkHistory<T = unknown> {
  id: string;
  module: HistoryModule;
  key: string | null;
  title: string;
  state: T;
  createdAt: string;
}

/**
 * Saves a recoverable page-state snapshot. The snapshot is auxiliary data and
 * callers should decide whether a history failure may fail the main workflow.
 */
export async function saveWorkHistory<T>(
  module: HistoryModule,
  title: string,
  state: T,
  key?: string
) {
  const response = await fetch("/api/history", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ module, title, state, key }),
  });
  if (!response.ok) throw new Error((await response.json()).error || "保存历史失败");
  return response.json() as Promise<WorkHistory<T>>;
}
