import type { Metadata } from "next";
import "./globals.css";
import AppShell from "@/components/AppShell";
import { PaletteProvider } from "@/features/appearance";

const paletteBootstrap = `(()=>{try{const k="chem-track:palette",a=["classic","midnight","nebula","balanced-nebula"],v=localStorage.getItem(k),p=a.includes(v)?v:"balanced-nebula";document.documentElement.dataset.palette=p;document.documentElement.style.colorScheme=p==="classic"?"light":"dark"}catch{document.documentElement.dataset.palette="balanced-nebula";document.documentElement.style.colorScheme="dark"}})()`;

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
    <html lang="zh-CN" className="h-full antialiased" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: paletteBootstrap }} /></head>
      <body><PaletteProvider><AppShell>{children}</AppShell></PaletteProvider></body>
    </html>
  );
}
