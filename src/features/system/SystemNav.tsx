import Link from "next/link";
const items = [{ href: "/system/configuration", label: "LLM 配置" }, { href: "/system/integrations", label: "集成与工具" }, { href: "/system/maintenance", label: "维护与日志" }];
export default function SystemNav() { return <nav className="mb-6 flex flex-wrap gap-2" aria-label="系统中心">{items.map((item) => <Link key={item.href} href={item.href} className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-600 hover:border-blue-300 hover:text-blue-700">{item.label}</Link>)}</nav>; }
