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
import { seedCourseCycleFixture } from "./course-cycle-test-fixture";
import { startE2ELlmStub } from "./e2e-llm-stub";

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
  fs.mkdirSync(path.join(serverRoot, "scripts"));
  fs.copyFileSync(
    path.join(projectRoot, "scripts", "purge-expired-recycle-bin.ts"),
    path.join(serverRoot, "scripts", "purge-expired-recycle-bin.ts"),
  );
  for (const file of [
    "LICENSE",
    "package.json",
    "next.config.ts",
    "postcss.config.mjs",
    "tsconfig.json",
  ]) {
    fs.copyFileSync(path.join(projectRoot, file), path.join(serverRoot, file));
  }
  fs.symlinkSync(
    path.join(projectRoot, "node_modules"),
    path.join(serverRoot, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  return serverRoot;
}

async function main() {
  const projectRoot = process.cwd();
  const testEnvironment = createIsolatedTestEnvironment();
  const fixtureArgument = process.argv.find((argument) => argument.startsWith("--fixture="));
  const fixtureProfile = fixtureArgument?.slice("--fixture=".length) ?? "default";
  if (!new Set(["default", "course-cycle", "core"]).has(fixtureProfile)) {
    throw new Error(`Unknown test fixture profile: ${fixtureProfile}`);
  }
  const childArguments = process.argv.slice(3).filter((argument) => !argument.startsWith("--fixture="));
  let llmStub: Awaited<ReturnType<typeof startE2ELlmStub>> | null = null;

  function cleanup() {
    if (llmStub) void llmStub.close();
    llmStub = null;
    removeIsolatedTestEnvironment(testEnvironment.rootDir);
  }

  function fail(message: string): never {
    cleanup();
    throw new Error(message);
  }

  assertSafeTestDatabaseUrl(testEnvironment.env.DATABASE_URL);
  if (mode === "playwright") {
    testEnvironment.env.E2E_APP_DIR = prepareE2EServerWorkspace(projectRoot, testEnvironment.rootDir);
    // Browser verification should exercise the built application.  Running
    // WebKit against Next's dev HMR server can let a late Fast Refresh reload
    // interrupt an otherwise valid document navigation.
    testEnvironment.env.E2E_SERVER_MODE = process.env.E2E_SERVER_MODE ?? "production";
  }
  testEnvironment.env.E2E_FIXTURE_PROFILE = fixtureProfile;
  if (fixtureProfile === "course-cycle" || fixtureProfile === "core") {
    llmStub = await startE2ELlmStub({ delayMs: 600 });
    testEnvironment.env.LLM_API_BASE_URL = `${llmStub.baseUrl}/v1`;
    testEnvironment.env.LLM_API_KEY = "test-course-cycle-key";
    testEnvironment.env.LLM_MODEL = "test-course-cycle-model";
    testEnvironment.env.E2E_LLM_STUB_URL = llmStub.baseUrl;
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
    if (fixtureProfile === "course-cycle") {
      await seedCourseCycleFixture(testEnvironment.env.DATABASE_URL);
    } else if (fixtureProfile === "default") {
      await seedTestFixture(testEnvironment.env.DATABASE_URL);
    }
  } catch (error) {
    cleanup();
    throw error;
  }

  const vitestCli = path.join(projectRoot, "node_modules", "vitest", "vitest.mjs");
  const playwrightCli = path.join(projectRoot, "node_modules", "@playwright", "test", "cli.js");
  const command = mode === "playwright" ? playwrightCli : vitestCli;
  const baseArgs = mode === "vitest-run"
    ? ["run"]
    : mode === "vitest-watch"
      ? ["--watch"]
      : mode === "vitest-coverage"
        ? ["run", "--coverage"]
        : ["test"];
  const args = [...baseArgs, ...childArguments];

  const child = spawn(process.execPath, [command, ...args], {
    cwd: projectRoot,
    env: testEnvironment.env,
    stdio: "inherit",
    detached: process.platform !== "win32",
  });

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      if (!child.killed && child.pid) {
        if (process.platform === "win32") {
          child.kill(signal);
        } else {
          try {
            process.kill(-child.pid, signal);
          } catch {
            child.kill(signal);
          }
        }
      }
      cleanup();
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
