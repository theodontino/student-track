import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  assertSafeTestDatabaseUrl,
  createIsolatedTestEnvironment,
  removeIsolatedTestEnvironment,
} from "./test-environment";
import { seedTestFixture } from "./test-fixture";

type TestMode = "vitest-run" | "vitest-watch" | "vitest-coverage" | "playwright";

const mode = process.argv[2] as TestMode | undefined;
if (!mode || !["vitest-run", "vitest-watch", "vitest-coverage", "playwright"].includes(mode)) {
  throw new Error("Usage: run-isolated-tests.ts <vitest-run|vitest-watch|vitest-coverage|playwright>");
}

function prepareE2EServerWorkspace(projectRoot: string, rootDir: string) {
  const serverRoot = path.join(rootDir, "server");
  fs.mkdirSync(serverRoot);

  for (const directory of ["src", "public"]) {
    fs.cpSync(path.join(projectRoot, directory), path.join(serverRoot, directory), { recursive: true });
  }
  for (const file of [
    "package.json",
    "next.config.ts",
    "postcss.config.mjs",
    "tsconfig.json",
    "next-env.d.ts",
  ]) {
    fs.copyFileSync(path.join(projectRoot, file), path.join(serverRoot, file));
  }
  fs.symlinkSync(path.join(projectRoot, "node_modules"), path.join(serverRoot, "node_modules"), "dir");
  return serverRoot;
}

async function main() {
  const projectRoot = process.cwd();
  const testEnvironment = createIsolatedTestEnvironment();
  let cleaned = false;

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    removeIsolatedTestEnvironment(testEnvironment.rootDir);
  }

  function fail(message: string): never {
    cleanup();
    throw new Error(message);
  }

  assertSafeTestDatabaseUrl(testEnvironment.env.DATABASE_URL);
  if (mode === "playwright") {
    testEnvironment.env.E2E_APP_DIR = prepareE2EServerWorkspace(projectRoot, testEnvironment.rootDir);
  }
  // Prisma 7's schema engine requires the SQLite file to exist when the URL
  // is an absolute path. Exclusive creation also guards against accidental reuse.
  fs.closeSync(fs.openSync(testEnvironment.databasePath, "wx", 0o600));

  const prismaCli = path.join(projectRoot, "node_modules", "prisma", "build", "index.js");
  const migrate = spawnSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: projectRoot,
    env: testEnvironment.env,
    stdio: "inherit",
  });
  if (migrate.error) fail(`Failed to start Prisma migrations: ${migrate.error.message}`);
  if (migrate.status !== 0) fail(`Prisma migrations failed with exit code ${migrate.status}`);

  process.env.DATABASE_URL = testEnvironment.env.DATABASE_URL;
  process.env.LLM_SETTINGS_PATH = testEnvironment.env.LLM_SETTINGS_PATH;
  process.env.DIARIZE_DATA_DIR = testEnvironment.env.DIARIZE_DATA_DIR;
  try {
    await seedTestFixture(testEnvironment.env.DATABASE_URL);
  } catch (error) {
    cleanup();
    throw error;
  }

  const vitestCli = path.join(projectRoot, "node_modules", "vitest", "vitest.mjs");
  const playwrightCli = path.join(projectRoot, "node_modules", "@playwright", "test", "cli.js");
  const command = mode === "playwright" ? playwrightCli : vitestCli;
  const args = mode === "vitest-run"
    ? ["run"]
    : mode === "vitest-watch"
      ? []
      : mode === "vitest-coverage"
        ? ["run", "--coverage"]
        : ["test"];

  const child = spawn(process.execPath, [command, ...args], {
    cwd: projectRoot,
    env: testEnvironment.env,
    stdio: "inherit",
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }

  child.once("error", (error) => {
    cleanup();
    console.error(error);
    process.exitCode = 1;
  });

  child.once("exit", (code, signal) => {
    cleanup();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });

  process.once("exit", cleanup);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
