import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./class-names";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("ui-card", className)} {...props} />;
}

export function Section({ title, description, actions, className, children, ...props }: HTMLAttributes<HTMLElement> & { title?: string; description?: string; actions?: ReactNode }) {
  return (
    <section className={cx("ui-section", className)} {...props}>
      {(title || description || actions) && <div className="ui-section__header"><div>{title && <h2>{title}</h2>}{description && <p>{description}</p>}</div>{actions && <div className="ui-section__actions">{actions}</div>}</div>}
      {children}
    </section>
  );
}

export function MetricCard({ label, value, detail, tone = "neutral", className }: { label: string; value: ReactNode; detail?: ReactNode; tone?: "neutral" | "brand" | "success" | "warning" | "danger"; className?: string }) {
  return <Card className={cx("ui-metric", `ui-metric--${tone}`, className)}><span className="ui-metric__label">{label}</span><strong className="ui-metric__value">{value}</strong>{detail && <span className="ui-metric__detail">{detail}</span>}</Card>;
}

export function Toolbar({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("ui-toolbar", className)} {...props} />;
}

export function FilterBar({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("ui-toolbar", "ui-filter-bar", className)} {...props} />;
}

export function ActionBar({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("ui-action-bar", className)} {...props} />;
}

export function PageHeader({ title, description, actions, context }: { title: string; description?: string; actions?: ReactNode; context?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="page-header__copy">
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {context && <div className="page-header__context">{context}</div>}
      {actions && <div className="page-header__actions">{actions}</div>}
    </header>
  );
}

export function Tabs({ items, value, onChange, label = "页面分区" }: { items: Array<{ value: string; label: string }>; value: string; onChange: (value: string) => void; label?: string }) {
  return <div className="ui-tabs" role="tablist" aria-label={label}>{items.map((item) => <button key={item.value} type="button" role="tab" aria-selected={item.value === value} onClick={() => onChange(item.value)}>{item.label}</button>)}</div>;
}

export function SegmentedControl({ items, value, onChange, label }: { items: Array<{ value: string; label: string }>; value: string; onChange: (value: string) => void; label: string }) {
  return <div className="ui-segmented" role="group" aria-label={label}>{items.map((item) => <button key={item.value} type="button" aria-pressed={item.value === value} onClick={() => onChange(item.value)}>{item.label}</button>)}</div>;
}
