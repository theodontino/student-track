import { configDefaults, defineConfig } from "vitest/config";
import path from "path";
import { assertSafeTestDatabaseUrl } from "./scripts/test-environment";

assertSafeTestDatabaseUrl();

export default defineConfig({
  test: {
    globals: true,
    fileParallelism: false,
    exclude: [...configDefaults.exclude, "e2e/**"],
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
