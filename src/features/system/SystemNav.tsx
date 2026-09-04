"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { getProductCapabilities, type ProductCapability } from "@/lib/product-edition";

const items: Array<{ href: string; label: string; capability?: ProductCapability }> = [
  { href: "/system/appearance", label: "外观" },
  { href: "/system/configuration", label: "LLM 配置" },
  { href: "/system/integrations", label: "集成与工具", capability: "integrationSettings" },
  { href: "/system/maintenance", label: "维护与日志" },
  { href: "/system/about", label: "关于" },
  { href: "/system/license", label: "开源许可" },
];

export default function SystemNav() {
  const pathname = usePathname();
  const capabilities = getProductCapabilities();
  return <nav className="system-nav" aria-label="系统中心">{items.filter((item) => !item.capability || capabilities[item.capability]).map((item) => <Link key={item.href} href={item.href} aria-current={pathname === item.href ? "page" : undefined}>{item.label}</Link>)}</nav>;
}
