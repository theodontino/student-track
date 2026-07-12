"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { AppIcon } from "@/components/AppIcon";
import { IconButton } from "@/components/ui";

const groups = [
  { label: "概览", items: [{ href: "/", label: "仪表盘", icon: "dashboard" as const }] },
  { label: "教学工作", items: [
    { href: "/feedback", label: "课后反馈", icon: "feedback" as const },
    { href: "/quick-score", label: "手动评分", icon: "score" as const },
    { href: "/entry", label: "课堂录入", icon: "entry" as const },
    { href: "/diarize", label: "录音转写", icon: "audio" as const },
  ] },
  { label: "学生与课程", items: [
    { href: "/students", label: "学生档案", icon: "students" as const },
    { href: "/semesters", label: "学期 / 课次", icon: "courses" as const },
  ] },
  { label: "报告与数据", items: [
    { href: "/daily-report", label: "班级日报", icon: "report" as const },
    { href: "/history", label: "工作历史", icon: "history" as const },
    { href: "/export", label: "数据导出", icon: "export" as const },
  ] },
  { label: "系统", items: [{ href: "/system/configuration", label: "系统中心", icon: "system" as const }] },
];

function Navigation({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return <><div className="app-brand"><span className="app-brand__mark">CT</span><div><strong>Chem-Track AI</strong><small>化学学生追踪系统</small></div></div><nav className="app-nav" aria-label="主导航">{groups.map((group) => <div key={group.label} className="app-nav__group"><p>{group.label}</p>{group.items.map((item) => { const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href) || (item.href.startsWith("/system") && pathname.startsWith("/system")); return <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined} className={active ? "is-active" : ""} onClick={onNavigate}><AppIcon name={item.icon} />{item.label}</Link>; })}</div>)}</nav><div className="app-sidebar__footer">本机单教师工作区</div></>;
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => { document.body.style.overflow = open ? "hidden" : ""; return () => { document.body.style.overflow = ""; }; }, [open]);
  return <div className="app-shell"><aside className="app-sidebar"><Navigation pathname={pathname} /></aside><div className="app-mobile-bar"><IconButton label="打开导航" onClick={() => setOpen(true)}><AppIcon name="menu" /></IconButton><strong>Chem-Track AI</strong></div>{open && <div className="app-drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}><aside className="app-drawer"><IconButton label="关闭导航" className="app-drawer__close" onClick={() => setOpen(false)}><AppIcon name="close" /></IconButton><Navigation pathname={pathname} onNavigate={() => setOpen(false)} /></aside></div>}<main className="app-content">{children}</main></div>;
}
