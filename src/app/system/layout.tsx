import SystemNav from "@/features/system/SystemNav";
export default function SystemLayout({ children }: { children: React.ReactNode }) { return <div className="mx-auto max-w-6xl"><div className="mb-5"><h1 className="text-2xl font-bold text-gray-900">系统中心</h1><p className="mt-1 text-sm text-gray-500">配置、集成和本机维护按职责分区。</p></div><SystemNav />{children}</div>; }
