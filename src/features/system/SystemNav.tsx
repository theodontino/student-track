"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/system/configuration", label: "LLM 配置" },
  { href: "/system/integrations", label: "集成与工具" },
  { href: "/system/maintenance", label: "维护与日志" },
];

export default function SystemNav() {
  const pathname = usePathname();
  return <nav className="system-nav" aria-label="系统中心">{items.map((item) => <Link key={item.href} href={item.href} aria-current={pathname === item.href ? "page" : undefined}>{item.label}</Link>)}</nav>;
}
