"use client";

import type { ReactNode } from "react";
import { useEffect, useId, useRef } from "react";
import { cx } from "./class-names";
import { Button, IconButton } from "./controls";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function Overlay({ open, title, children, onClose, kind }: { open: boolean; title: string; children: ReactNode; onClose: () => void; kind: "dialog" | "drawer" }) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) { event.preventDefault(); return; }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
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

export function ConfirmDialog({ open, title, description, confirmLabel = "确认", cancelLabel = "取消", danger = false, busy = false, onConfirm, onClose }: { open: boolean; title: string; description: ReactNode; confirmLabel?: string; cancelLabel?: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onClose: () => void }) {
  return <Dialog open={open} title={title} onClose={onClose}><div className="ui-confirm-dialog"><div>{description}</div><div className="ui-confirm-dialog__actions"><Button variant="secondary" onClick={onClose} disabled={busy}>{cancelLabel}</Button><Button variant={danger ? "danger" : "primary"} onClick={onConfirm} disabled={busy}>{busy ? "处理中…" : confirmLabel}</Button></div></div></Dialog>;
}
