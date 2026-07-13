import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./class-names";

type Tone = "neutral" | "info" | "success" | "warning" | "danger";
export type SaveState = "clean" | "dirty" | "saving" | "saved" | "error";

export function Badge({ tone = "neutral", className, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return <span className={cx("ui-badge", `ui-badge--${tone}`, className)} {...props} />;
}

export function StatusDot({ tone = "neutral", label }: { tone?: Tone; label: string }) {
  return <span className="ui-status-dot"><span className={cx("ui-status-dot__mark", `ui-status-dot__mark--${tone}`)} aria-hidden="true" />{label}</span>;
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return <div className="ui-state"><strong>{title}</strong>{description && <p>{description}</p>}{action}</div>;
}

export function LoadingState({ label = "正在加载…" }: { label?: string }) {
  return <div className="ui-state" role="status"><span className="ui-spinner" />{label}</div>;
}

export function Skeleton({ className, label = "内容加载中" }: { className?: string; label?: string }) {
  return <span className={cx("ui-skeleton", className)} role="status"><span className="sr-only">{label}</span></span>;
}

export function ErrorState({ message, action }: { message: string; action?: ReactNode }) {
  return <div className="ui-state ui-state--error" role="alert"><strong>加载失败</strong><p>{message}</p>{action}</div>;
}

export function StatusBanner({ tone = "info", children }: { tone?: Exclude<Tone, "neutral">; children: ReactNode }) {
  return <div className={cx("ui-banner", `ui-banner--${tone}`)} role={tone === "danger" ? "alert" : "status"}>{children}</div>;
}

const saveLabels: Record<SaveState, string> = { clean: "没有未保存修改", dirty: "有未保存修改", saving: "正在保存", saved: "已保存", error: "保存失败，可重试" };
const saveTones: Record<SaveState, Tone> = { clean: "neutral", dirty: "warning", saving: "info", saved: "success", error: "danger" };

export function SaveStateIndicator({ state, label }: { state: SaveState; label?: string }) {
  return <StatusDot tone={saveTones[state]} label={label ?? saveLabels[state]} />;
}
