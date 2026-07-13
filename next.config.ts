import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@libsql/client"],
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
