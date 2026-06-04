"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/", label: "仪表盘", icon: "📊" },
  { href: "/students", label: "学生管理", icon: "👤" },
  { href: "/quick-score", label: "快速评分", icon: "⚡" },
  { href: "/input", label: "NL 录入", icon: "✏️" },
  { href: "/review", label: "复核", icon: "✅" },
  { href: "/export", label: "导出", icon: "📥" },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-56 bg-white border-r border-gray-200 flex flex-col shrink-0">
      <div className="p-5 border-b border-gray-100">
        <h1 className="text-lg font-bold text-blue-700">Chem-Track AI</h1>
        <p className="text-xs text-gray-400 mt-0.5">化学学生追踪系统</p>
      </div>
      <nav className="flex-1 p-3 space-y-1">
        {NAV_ITEMS.map((item) => {
          const isActive =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isActive
                  ? "bg-blue-50 text-blue-700"
                  : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
              }`}
            >
              <span className="text-lg">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="p-4 border-t border-gray-100 text-xs text-gray-400 text-center">
        单教师版
      </div>
    </aside>
  );
}
