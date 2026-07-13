import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { cx } from "./class-names";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ControlSize = "sm" | "md" | "lg";

export function Button({ className, type = "button", variant = "primary", uiSize = "md", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; uiSize?: ControlSize }) {
  return <button type={type} className={cx("ui-button", `ui-button--${variant}`, `ui-button--${uiSize}`, className)} {...props} />;
}

export function IconButton({ label, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type="button" aria-label={label} title={label} className={cx("ui-icon-button", className)} {...props} />;
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx("ui-field", className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx("ui-field", "ui-textarea", className)} {...props} />;
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx("ui-field", className)} {...props} />;
}

export function FormField({ id, label, description, error, required, children, className }: { id?: string; label: string; description?: string; error?: string; required?: boolean; children: ReactNode; className?: string }) {
  return (
    <div className={cx("ui-form-field", className)}>
      <label htmlFor={id}>{label}{required && <span aria-hidden="true"> *</span>}</label>
      {description && <p className="ui-form-field__description">{description}</p>}
      {children}
      {error && <p className="ui-form-field__error" role="alert">{error}</p>}
    </div>
  );
}
