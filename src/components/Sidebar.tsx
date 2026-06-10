"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavGroup {
  label: string;
  icon: string;
  children: { href: string; label: string; icon: string }[];
}

const GROUPS: NavGroup[] = [
  {
    label: "课后评价",
    icon: "📝",
    children: [
      { href: "/quick-score", label: "快速评分", icon: "⚡" },
      { href: "/input", label: "NL 录入", icon: "✏️" },
      { href: "/review", label: "复核", icon: "✅" },
    ],
  },
  {
    label: "报告和导出",
    icon: "📦",
    children: [
      { href: "/report", label: "报告", icon: "📋" },
      { href: "/export", label: "导出", icon: "📥" },
    ],
  },
  {
    label: "管理",
    icon: "⚙️",
    children: [
      { href: "/students", label: "学生管理", icon: "👤" },
      { href: "/semesters", label: "学期", icon: "📅" },
    ],
  },
];

export default function Sidebar() {
  const pathname = usePathname();
  // 默认全部展开
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  function toggle(label: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  function isGroupActive(group: NavGroup): boolean {
    return group.children.some((c) => pathname.startsWith(c.href));
  }

  return (
    <aside className="w-56 bg-white border-r border-gray-200 flex flex-col shrink-0 overflow-y-auto">
      {/* Brand */}
      <div className="p-5 border-b border-gray-100">
        <h1 className="text-lg font-bold text-blue-700">Chem-Track AI</h1>
        <p className="text-xs text-gray-400 mt-0.5">化学学生追踪系统</p>
      </div>

      <nav className="flex-1 p-3 space-y-4">
        {/* Dashboard — always on top */}
        <Link
          href="/"
          className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
            pathname === "/"
              ? "bg-blue-50 text-blue-700"
              : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
          }`}
        >
          <span className="text-lg">📊</span>
          仪表盘
        </Link>

        {/* Groups */}
        {GROUPS.map((group) => {
          const active = isGroupActive(group);
          const isOpen = !collapsed.has(group.label);

          return (
            <div key={group.label}>
              <button
                onClick={() => toggle(group.label)}
                className={`w-full flex items-center gap-2 px-3 py-1 text-xs font-semibold uppercase tracking-wide transition-colors ${
                  active ? "text-blue-600" : "text-gray-400 hover:text-gray-600"
                }`}
              >
                <span>{group.icon}</span>
                <span className="flex-1 text-left">{group.label}</span>
                <span className={`text-[10px] transition-transform ${isOpen ? "rotate-90" : ""}`}>
                  ▶
                </span>
              </button>

              {isOpen && (
                <div className="mt-1 space-y-0.5">
                  {group.children.map((child) => {
                    const childActive = pathname.startsWith(child.href);
                    return (
                      <Link
                        key={child.href}
                        href={child.href}
                        className={`flex items-center gap-3 pl-8 pr-3 py-2 rounded-lg text-sm transition-colors ${
                          childActive
                            ? "bg-blue-50 text-blue-700 font-medium"
                            : "text-gray-500 hover:bg-gray-50 hover:text-gray-800"
                        }`}
                      >
                        <span className="text-base">{child.icon}</span>
                        {child.label}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className="p-4 border-t border-gray-100 text-xs text-gray-400 text-center">
        单教师版
      </div>
    </aside>
  );
}
