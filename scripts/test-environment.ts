import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TEST_TEMP_PREFIX = "chem-track-ai-test-";

export interface IsolatedTestEnvironment {
  rootDir: string;
  databasePath: string;
  env: NodeJS.ProcessEnv;
}

function normalizedPath(value: string) {
  return path.resolve(value);
}

export function assertSafeTestDirectory(directory: string) {
  const resolved = normalizedPath(directory);
  const tempRoot = normalizedPath(os.tmpdir());
  const relative = path.relative(tempRoot, resolved);
  const basename = path.basename(resolved);

  if (
    !basename.startsWith(TEST_TEMP_PREFIX)
    || relative.startsWith("..")
    || path.isAbsolute(relative)
  ) {
    throw new Error(`Refusing to use unsafe test directory: ${resolved}`);
  }

  return resolved;
}

export function databasePathFromUrl(databaseUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("Test DATABASE_URL must be an absolute file: URL");
  }
  if (parsed.protocol !== "file:") {
    throw new Error("Test DATABASE_URL must use the file: protocol");
  }
  return normalizedPath(fileURLToPath(parsed));
}

export function assertSafeTestDatabaseUrl(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) throw new Error("DATABASE_URL is required for tests");

  const databasePath = databasePathFromUrl(databaseUrl);
  const testDirectory = assertSafeTestDirectory(path.dirname(databasePath));
  if (path.dirname(databasePath) !== testDirectory || path.basename(databasePath) !== "test.db") {
    throw new Error(`Refusing to use unsafe test database: ${databasePath}`);
  }

  const projectRoot = normalizedPath(process.cwd());
  const forbiddenRoots = [
    path.join(projectRoot, "dev.db"),
    path.join(projectRoot, "archives"),
    path.join(projectRoot, "data"),
  ];
  if (forbiddenRoots.some((candidate) => (
    databasePath === candidate || databasePath.startsWith(`${candidate}${path.sep}`)
  ))) {
    throw new Error(`Refusing to use project data for tests: ${databasePath}`);
  }

  return databasePath;
}

export function createIsolatedTestEnvironment(): IsolatedTestEnvironment {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), TEST_TEMP_PREFIX));
  assertSafeTestDirectory(rootDir);
  const databasePath = path.join(rootDir, "test.db");
  // Prisma's SQLite schema engine expects the single-slash absolute form.
  const databaseUrl = `file:${databasePath}`;
  assertSafeTestDatabaseUrl(databaseUrl);

  return {
    rootDir,
    databasePath,
    env: {
      ...process.env,
      NODE_ENV: "test",
      NEXT_TELEMETRY_DISABLED: "1",
      DATABASE_URL: databaseUrl,
      LLM_SETTINGS_PATH: path.join(rootDir, "llm-settings.json"),
      DIARIZE_DATA_DIR: path.join(rootDir, "diarize"),
      LLM_API_BASE_URL: "http://127.0.0.1:9/v1",
      LLM_API_KEY: "e2e-disabled",
      LLM_MODEL: "e2e-disabled",
    },
  };
}

export function removeIsolatedTestEnvironment(rootDir: string) {
  const safeRoot = assertSafeTestDirectory(rootDir);
  fs.rmSync(safeRoot, { recursive: true, force: true });
}
