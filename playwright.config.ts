import { defineConfig, devices } from "@playwright/test";
import { assertSafeTestDatabaseUrl } from "./scripts/test-environment";

assertSafeTestDatabaseUrl();

const port = Number(process.env.E2E_PORT || 3316);
const baseURL = `http://127.0.0.1:${port}`;
const serverRoot = process.env.E2E_APP_DIR;
if (!serverRoot) throw new Error("E2E_APP_DIR is required; run E2E through npm run test:e2e");
const serverMode = process.env.E2E_SERVER_MODE === "production" ? "production" : "development";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: serverMode === "production"
      ? `npm run build -- --webpack && npm run start -- --port ${port}`
      : `npm run dev -- --webpack --port ${port}`,
    cwd: serverRoot,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
  ],
});
