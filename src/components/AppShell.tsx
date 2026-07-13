"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AppIcon } from "@/components/AppIcon";
import { IconButton } from "@/components/ui";
import { applyTeachingContext, readStoredTeachingContext } from "@/features/teaching-context";

type NavigationItem = {
  href: string;
  label: string;
  icon: Parameters<typeof AppIcon>[0]["name"];
  context?: "semester" | "full";
};

const groups: Array<{ label: string; items: NavigationItem[] }> = [
  { label: "概览", items: [{ href: "/", label: "仪表盘", icon: "dashboard", context: "semester" }] },
  { label: "教学工作", items: [
    { href: "/feedback", label: "课后反馈", icon: "feedback", context: "full" },
    { href: "/quick-score", label: "手动评分", icon: "score", context: "full" },
    { href: "/entry", label: "课堂录入", icon: "entry", context: "full" },
    { href: "/diarize", label: "录音转写", icon: "audio" },
  ] },
  { label: "学生与课程", items: [
    { href: "/students", label: "学生档案", icon: "students", context: "semester" },
    { href: "/semesters", label: "学期 / 课次", icon: "courses" },
  ] },
  { label: "报告与数据", items: [
    { href: "/daily-report", label: "班级日报", icon: "report", context: "full" },
    { href: "/history", label: "工作历史", icon: "history" },
    { href: "/export", label: "数据导出", icon: "export" },
  ] },
  { label: "系统", items: [{ href: "/system/configuration", label: "系统中心", icon: "system" }] },
];

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  if (href.startsWith("/system")) return pathname.startsWith("/system");
  return pathname.startsWith(href);
}

function Navigation({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  const router = useRouter();

  function navigateWithContext(event: React.MouseEvent<HTMLAnchorElement>, item: NavigationItem) {
    onNavigate?.();
    if (!item.context) return;
    const context = readStoredTeachingContext(window.sessionStorage);
    if (!context) return;
    event.preventDefault();
    const url = applyTeachingContext(new URL(item.href, window.location.origin), context);
    if (item.context === "semester") {
      url.searchParams.delete("class");
      url.searchParams.delete("sessionCode");
    }
    router.push(`${url.pathname}${url.search}`);
  }

  return (
    <>
      <div className="app-brand" aria-label="Chem-Track AI">
        <span className="app-brand__mark" aria-hidden="true">CT</span>
        <div><strong>Chem-Track AI</strong><small>化学学生追踪系统</small></div>
      </div>
      <nav className="app-nav" aria-label="主导航">
        {groups.map((group) => (
          <div key={group.label} className="app-nav__group">
            <p>{group.label}</p>
            {group.items.map((item) => {
              const active = isActive(pathname, item.href);
              return <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined} className={active ? "is-active" : ""} onClick={(event) => navigateWithContext(event, item)}><AppIcon name={item.icon} />{item.label}</Link>;
            })}
          </div>
        ))}
      </nav>
      <div className="app-sidebar__footer">
        <span>工作状态保留在当前标签页</span>
        <span>本机单教师工作区</span>
        <a href="https://github.com/theodontino/studentdatabase" target="_blank" rel="noreferrer">源代码 · AGPL-3.0</a>
      </div>
    </>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const currentLabel = useMemo(() => groups.flatMap((group) => group.items).find((item) => isActive(pathname, item.href))?.label ?? "Chem-Track AI", [pathname]);

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    const handleKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", handleKey);
      previous?.focus();
    };
  }, [open]);

  return (
    <div className="app-shell">
      <a className="app-skip-link" href="#main-content">跳到主要内容</a>
      <aside className="app-sidebar"><Navigation pathname={pathname} /></aside>
      <div className="app-mobile-bar">
        <IconButton label="打开导航" onClick={() => setOpen(true)}><AppIcon name="menu" /></IconButton>
        <div><small>Chem-Track AI</small><strong>{currentLabel}</strong></div>
      </div>
      {open && <div className="app-drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}><aside className="app-drawer" role="dialog" aria-modal="true" aria-label="主导航抽屉"><IconButton autoFocus label="关闭导航" className="app-drawer__close" onClick={() => setOpen(false)}><AppIcon name="close" /></IconButton><Navigation pathname={pathname} onNavigate={() => setOpen(false)} /></aside></div>}
      <main id="main-content" className="app-content" tabIndex={-1}>{children}</main>
    </div>
  );
}
