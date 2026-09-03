import { configDefaults, defineConfig } from "vitest/config";
import path from "path";
import { assertSafeTestDatabaseUrl } from "./scripts/test-environment";

assertSafeTestDatabaseUrl();

const isCoreEdition = (
  process.env.STUDENT_TRACK_EDITION
  ?? process.env.NEXT_PUBLIC_STUDENT_TRACK_EDITION
) === "core";

const coreTestExcludes = [
  "src/tests/api/wecomcatch-integration.test.ts",
  "src/tests/diarize-api.test.ts",
  "src/tests/diarize-tasks.test.ts",
  "src/tests/local-tool-status-panel.test.tsx",
  "src/tests/wecom-*.test.ts",
];

const coreCoverageExcludes = [
  "src/app/api/diarize/**",
  "src/app/api/integrations/wecomcatch/**",
  "src/app/api/wecom/**",
  "src/features/entry/diarize-*.ts",
  "src/features/entry/use-audio-recorder.ts",
  "src/features/useWeComAccess.ts",
  "src/features/wecom-access.ts",
  "src/features/wecom/**",
  "src/lib/contracts/diarize.ts",
  "src/lib/contracts/wecom-file-transfer.ts",
  "src/lib/diarize-*.ts",
  "src/lib/local-tool-status.ts",
  "src/services/local-tool-status-service.ts",
  "src/services/wecom-*.ts",
];

export default defineConfig({
  test: {
    globals: true,
    fileParallelism: false,
    exclude: [
      ...configDefaults.exclude,
      "e2e/**",
      ...(isCoreEdition ? coreTestExcludes : []),
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportsDirectory: "coverage",
      include: [
        "src/app/api/**/*.ts",
        "src/services/**/*.ts",
        "src/lib/**/*.ts",
        "src/features/**/*.ts",
      ],
      exclude: [
        "src/tests/**",
        "src/generated/**",
        "src/config/**",
        "src/**/types.ts",
        "src/**/index.ts",
        // Interactive presentation is exercised by Playwright. Hooks, reducers,
        // API modules, services and pure TypeScript remain in the Vitest scope.
        "src/features/**/*.tsx",
        "src/components/ui/**/*.tsx",
        "scripts/test-*.ts",
        ...(isCoreEdition ? coreCoverageExcludes : []),
      ],
      thresholds: {
        statements: 49,
        branches: 48,
        functions: 54,
        lines: 53,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
