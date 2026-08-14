import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@libsql/client"],
  experimental: {
    // 课后报告通常是一批 PDF；proxy 默认只缓存 10MB，会截断 multipart body。
    proxyClientMaxBodySize: "100mb",
  },
  turbopack: {
    ignoreIssue: [
      {
        path: "**/next.config.ts",
        title: "Encountered unexpected file in NFT list",
      },
    ],
  },
  outputFileTracingExcludes: {
    "/*": [
      "./archives/**/*",
      "./coverage/**/*",
      "./data/**/*",
      "./docs/**/*",
      "./e2e/**/*",
      "./playwright-report/**/*",
      "./scripts/**/*",
      "./src/tests/**/*",
      "./test-results/**/*",
      "./dev.db",
      "./prisma/dev.db",
      "./*.tsbuildinfo",
    ],
  },
};

export default nextConfig;
