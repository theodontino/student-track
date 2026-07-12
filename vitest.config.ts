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
      exclude: [
        "src/tests/**",
        "src/generated/**",
        "src/config/**",
        "scripts/test-*.ts",
      ],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
