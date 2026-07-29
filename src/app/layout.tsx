import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";
import AppShell from "@/components/AppShell";
import { PaletteProvider } from "@/features/appearance";

const paletteBootstrap = `(()=>{try{const k="student-track:palette",o="chem-track:palette",a=["classic","midnight","nebula","balanced-nebula"],v=localStorage.getItem(k)??localStorage.getItem(o),p=a.includes(v)?v:"balanced-nebula";localStorage.setItem(k,p);document.documentElement.dataset.palette=p;document.documentElement.style.colorScheme=p==="classic"?"light":"dark"}catch{document.documentElement.dataset.palette="balanced-nebula";document.documentElement.style.colorScheme="dark"}})()`;

export const metadata: Metadata = {
  title: "Student Track - 化学学生追踪系统",
  description: "高中化学学生智能追踪系统",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-full antialiased" suppressHydrationWarning>
      <body>
        <Script id="palette-bootstrap" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: paletteBootstrap }} />
        <PaletteProvider><AppShell>{children}</AppShell></PaletteProvider>
      </body>
    </html>
  );
}
