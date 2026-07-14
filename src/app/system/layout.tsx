import SystemNav from "@/features/system/SystemNav";
export default function SystemLayout({ children }: { children: React.ReactNode }) { return <div className="system-center"><header><h1>系统中心</h1><p>配置、集成和本机维护按职责分区。</p></header><SystemNav />{children}</div>; }
