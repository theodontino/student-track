"use client";

import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { useEffect, useId, useRef } from "react";

export function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function Button({ className, type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const { variant = "primary", ...rest } = props;
  return <button type={type} className={cx("ui-button", `ui-button--${variant}`, className)} {...rest} />;
}

export function IconButton({ label, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type="button" aria-label={label} title={label} className={cx("ui-icon-button", className)} {...props} />;
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("ui-card", className)} {...props} />;
}

export function Badge({ tone = "neutral", className, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: "neutral" | "info" | "success" | "warning" | "danger" }) {
  return <span className={cx("ui-badge", `ui-badge--${tone}`, className)} {...props} />;
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx("ui-field", className)} {...props} />;
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx("ui-field", className)} {...props} />;
}

export function PageHeader({ title, description, actions, context }: { title: string; description?: string; actions?: ReactNode; context?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="min-w-0">
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {context && <div className="page-header__context">{context}</div>}
      {actions && <div className="page-header__actions">{actions}</div>}
    </header>
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return <div className="ui-state"><strong>{title}</strong>{description && <p>{description}</p>}{action}</div>;
}

export function LoadingState({ label = "正在加载…" }: { label?: string }) {
  return <div className="ui-state" role="status"><span className="ui-spinner" />{label}</div>;
}

export function ErrorState({ message, action }: { message: string; action?: ReactNode }) {
  return <div className="ui-state ui-state--error" role="alert"><strong>加载失败</strong><p>{message}</p>{action}</div>;
}

export function StatusBanner({ tone = "info", children }: { tone?: "info" | "success" | "warning" | "danger"; children: ReactNode }) {
  return <div className={cx("ui-banner", `ui-banner--${tone}`)} role={tone === "danger" ? "alert" : "status"}>{children}</div>;
}

export function Tabs({ items, value, onChange, label = "页面分区" }: { items: Array<{ value: string; label: string }>; value: string; onChange: (value: string) => void; label?: string }) {
  return <div className="ui-tabs" role="tablist" aria-label={label}>{items.map((item) => <button key={item.value} role="tab" aria-selected={item.value === value} onClick={() => onChange(item.value)}>{item.label}</button>)}</div>;
}

function Overlay({ open, title, children, onClose, kind }: { open: boolean; title: string; children: ReactNode; onClose: () => void; kind: "dialog" | "drawer" }) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", handleKey);
    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", handleKey);
      previous?.focus();
    };
  }, [open, onClose]);
  if (!open) return null;
  return <div className="ui-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} className={cx("ui-overlay__panel", `ui-overlay__panel--${kind}`)}><div className="ui-overlay__header"><h2 id={titleId}>{title}</h2><IconButton label="关闭" onClick={onClose}>×</IconButton></div>{children}</div></div>;
}

export function Dialog(props: Omit<Parameters<typeof Overlay>[0], "kind">) { return <Overlay {...props} kind="dialog" />; }
export function Drawer(props: Omit<Parameters<typeof Overlay>[0], "kind">) { return <Overlay {...props} kind="drawer" />; }
