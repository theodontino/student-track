import type { Metadata } from "next";
import "./globals.css";
import AppShell from "@/components/AppShell";

export const metadata: Metadata = {
  title: "Chem-Track AI - 化学学生追踪系统",
  description: "高中化学学生智能追踪系统",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body><AppShell>{children}</AppShell></body>
    </html>
  );
}
