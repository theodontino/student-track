export const CI_LEVELS = ["L0", "L1", "L2", "L3"] as const;
export type CiLevel = typeof CI_LEVELS[number];

export const CI_SCOPES = [
  "docs",
  "generated-docs",
  "release-record",
  "app",
  "browser",
  "build",
  "windows",
  "macos",
  "database",
  "contract",
  "ci",
  "release",
  "unknown",
] as const;
export type CiScope = typeof CI_SCOPES[number];

export interface ChangedPath {
  path: string;
  previousPath?: string;
  status?: string;
}

export interface CiClassificationFacts {
  productVersionChanged?: boolean;
  forceLevel?: CiLevel;
  forceScopes?: CiScope[];
}

export interface ClassifiedChange extends ChangedPath {
  level: CiLevel;
  scopes: CiScope[];
  reasons: string[];
}

export interface CiClassification {
  level: CiLevel;
  scopes: CiScope[];
  files: ClassifiedChange[];
  reasons: string[];
}

export interface CiCheckPlan {
  documentation: boolean;
  privacy: boolean;
  releaseRecord: boolean;
  lint: boolean;
  typecheck: boolean;
  unit: boolean;
  chromiumSmoke: boolean;
  chromiumFull: boolean;
  webkitFull: boolean;
  productionBuild: boolean;
  windowsCore: boolean;
  macosFull: boolean;
  databaseUpgrade: boolean;
  contractCheck: boolean;
  ciPolicy: boolean;
  privacyHistory: boolean;
  release: boolean;
}

export interface ProductEvidenceInput {
  headSha: string;
  productVerifiedSha?: string;
  productVerifiedShaIsAncestor: boolean;
  cumulativeChanges: ChangedPath[];
}

export interface ProductEvidenceDecision {
  canInherit: boolean;
  productVerifiedShaCandidate: string;
  reason: "current" | "docs-only-descendant" | "missing" | "not-ancestor" | "product-changed";
  cumulativeClassification: CiClassification;
}

type PathImpact = {
  level: CiLevel;
  scopes: CiScope[];
  reasons: string[];
};

const LEVEL_RANK: Record<CiLevel, number> = {
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3,
};

const MIN_LEVEL_BY_FORCED_SCOPE: Record<CiScope, CiLevel> = {
  docs: "L0",
  "generated-docs": "L0",
  "release-record": "L0",
  app: "L1",
  browser: "L2",
  build: "L2",
  windows: "L2",
  macos: "L2",
  database: "L3",
  contract: "L3",
  ci: "L2",
  release: "L3",
  unknown: "L2",
};

const ROOT_DOCUMENTATION = new Set([
  "README.md",
  "CONTRIBUTING.md",
  "AGENTS.md",
  "CLAUDE.md",
  "LICENSE",
]);

const BUILD_CONFIG = new Set([
  "package.json",
  "package-lock.json",
  "next.config.ts",
  "tsconfig.json",
  "postcss.config.mjs",
  "eslint.config.mjs",
  "prisma.config.ts",
  ".nvmrc",
]);

const HIGH_RISK_DATABASE_FILES = new Set([
  "scripts/database-fingerprint.ts",
  "scripts/db-backup.ts",
  "scripts/db-maintain.ts",
  "scripts/db-restore.ts",
  "scripts/db-verify-backup.ts",
  "scripts/verify-database-upgrade.ts",
  "src/services/database-backup-service.ts",
]);

const CI_POLICY_FILES = new Set([
  "scripts/ci-policy.ts",
  "scripts/classify-ci-changes.ts",
  "scripts/resolve-ci-evidence.ts",
  "scripts/verify-agent.ts",
  "src/tests/ci-policy.test.ts",
]);

const TEST_INFRASTRUCTURE_FILES = new Set([
  "playwright.config.ts",
  "vitest.config.ts",
  "scripts/run-isolated-tests.ts",
  "scripts/test-environment.ts",
  "scripts/test-fixture.ts",
  "scripts/test-fixture-data.ts",
  "scripts/course-cycle-test-fixture.ts",
  "scripts/course-cycle-test-fixture-data.ts",
  "scripts/e2e-llm-stub.ts",
]);

const PLATFORM_PRODUCT_FILES = new Map<string, CiScope[]>([
  ["src/lib/runtime-paths.ts", ["app", "windows", "macos"]],
  ["src/lib/sqlite-file-url.ts", ["app", "windows"]],
  ["src/lib/product-edition.ts", ["app", "build", "windows"]],
  ["src/lib/product-api-access.ts", ["app", "build", "windows"]],
  ["src/lib/product-capability-guard.ts", ["app", "build", "windows"]],
  ["src/proxy.ts", ["app", "build", "windows"]],
]);

function normalizeRepoPath(value: string) {
  return value.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function highestLevel(levels: Iterable<CiLevel>): CiLevel {
  let result: CiLevel = "L0";
  for (const level of levels) {
    if (LEVEL_RANK[level] > LEVEL_RANK[result]) result = level;
  }
  return result;
}

function sortedScopes(scopes: Iterable<CiScope>) {
  const values = new Set(scopes);
  return CI_SCOPES.filter((scope) => values.has(scope));
}

function isStrictDocumentationPath(path: string) {
  if (ROOT_DOCUMENTATION.has(path)) return true;
  if (path === "docs/contracts/README.md") return true;
  if (path.startsWith("docs/contracts/")) return false;
  if (/^docs\/.+\.md$/.test(path)) return true;
  if (/^OLD\/.+\.md$/.test(path)) return true;
  return /^\.github\/ISSUE_TEMPLATE\/.+\.ya?ml$/.test(path);
}

function classifyPath(rawPath: string): PathImpact {
  const path = normalizeRepoPath(rawPath);

  if (isStrictDocumentationPath(path)) {
    const scopes: CiScope[] = ["docs"];
    if (/^docs\/release-evidence\/.+\.md$/.test(path)) scopes.push("release-record");
    return { level: "L0", scopes, reasons: ["strict documentation allowlist"] };
  }

  if (path.startsWith("docs/contracts/")) {
    return {
      level: "L3",
      scopes: ["contract"],
      reasons: ["cross-repository contract snapshot"],
    };
  }

  if (path.startsWith("prisma/")) {
    const scopes: CiScope[] = ["database"];
    if (path === "prisma/schema.prisma") scopes.push("generated-docs");
    return { level: "L3", scopes, reasons: ["database schema, migration, or seed"] };
  }

  if (HIGH_RISK_DATABASE_FILES.has(path)) {
    return {
      level: "L3",
      scopes: path.startsWith("src/") ? ["app", "database"] : ["database"],
      reasons: ["backup, restore, upgrade, or database safety boundary"],
    };
  }

  if (path.startsWith(".github/workflows/")) {
    const scopes: CiScope[] = ["ci"];
    if (path.endsWith("/documentation.yml") || path.endsWith("/documentation.yaml")) scopes.push("docs");
    if (path.endsWith("/webkit.yml") || path.endsWith("/webkit.yaml")) scopes.push("browser");
    if (path.endsWith("/ci.yml") || path.endsWith("/ci.yaml")) {
      scopes.push("browser", "build", "windows", "macos");
    }
    return { level: "L2", scopes, reasons: ["CI execution policy"] };
  }

  if (CI_POLICY_FILES.has(path)) {
    return { level: "L2", scopes: ["ci"], reasons: ["CI classifier or verification runner"] };
  }

  if (path.startsWith("e2e/")) {
    const scopes: CiScope[] = ["browser"];
    if (path === "e2e/core-edition.spec.ts") scopes.push("windows");
    return { level: "L2", scopes, reasons: ["browser integration coverage"] };
  }

  if (TEST_INFRASTRUCTURE_FILES.has(path)) {
    const scopes: CiScope[] = ["ci"];
    if (path === "playwright.config.ts" || path.startsWith("scripts/")) scopes.push("browser");
    if (path === "vitest.config.ts" || path === "scripts/test-environment.ts" || path === "scripts/run-isolated-tests.ts") {
      scopes.push("windows");
    }
    return { level: "L2", scopes, reasons: ["test execution infrastructure"] };
  }

  if (path.startsWith("scripts/windows/") || path === "src/tests/windows-core-scripts.test.ts") {
    return { level: "L2", scopes: ["windows"], reasons: ["Windows Core runtime"] };
  }

  if (path === "diarize.sh") {
    return { level: "L2", scopes: ["macos"], reasons: ["macOS Full external-tool entrypoint"] };
  }

  const platformScopes = PLATFORM_PRODUCT_FILES.get(path);
  if (platformScopes) {
    return { level: "L2", scopes: platformScopes, reasons: ["cross-platform product boundary"] };
  }

  if (BUILD_CONFIG.has(path)) {
    const scopes: CiScope[] = ["build"];
    if (path === "package.json" || path === "package-lock.json" || path === "next.config.ts" || path === ".nvmrc") {
      scopes.push("windows", "macos");
    }
    if (path === "prisma.config.ts") scopes.push("database");
    return { level: "L2", scopes, reasons: ["build or dependency configuration"] };
  }

  if (/^src\/.+\.css$/.test(path)) {
    return { level: "L2", scopes: ["app", "browser"], reasons: ["cross-browser presentation"] };
  }

  if (/^src\/app\/api(?:\/.+)?\/route\.ts$/.test(path)) {
    return {
      level: "L1",
      scopes: ["app", "generated-docs"],
      reasons: ["normal application API change"],
    };
  }

  if (path.startsWith("src/") || path.startsWith("public/")) {
    return { level: "L1", scopes: ["app"], reasons: ["normal application change"] };
  }

  return { level: "L2", scopes: ["unknown"], reasons: ["path is outside the explicit policy"] };
}

function classifyChange(change: ChangedPath): ClassifiedChange {
  const currentPath = normalizeRepoPath(change.path);
  const impacts = [classifyPath(currentPath)];
  const previousPath = change.previousPath ? normalizeRepoPath(change.previousPath) : undefined;
  if (previousPath && previousPath !== currentPath) impacts.push(classifyPath(previousPath));

  return {
    ...change,
    path: currentPath,
    ...(previousPath ? { previousPath } : {}),
    level: highestLevel(impacts.map((impact) => impact.level)),
    scopes: sortedScopes(impacts.flatMap((impact) => impact.scopes)),
    reasons: [...new Set(impacts.flatMap((impact) => impact.reasons))],
  };
}

export function classifyCiChanges(
  changes: ChangedPath[],
  facts: CiClassificationFacts = {},
): CiClassification {
  const files = changes.map(classifyChange);
  const scopes = new Set(files.flatMap((file) => file.scopes));
  const levels = files.map((file) => file.level);
  const reasons: string[] = [];

  if (facts.productVersionChanged) {
    levels.push("L3");
    scopes.add("release");
    reasons.push("product version changed");
  }

  for (const scope of facts.forceScopes ?? []) {
    scopes.add(scope);
    levels.push(MIN_LEVEL_BY_FORCED_SCOPE[scope]);
  }
  if ((facts.forceScopes?.length ?? 0) > 0) reasons.push("CI scopes were explicitly raised");

  if (facts.forceLevel) {
    levels.push(facts.forceLevel);
    reasons.push(`CI level was explicitly raised to ${facts.forceLevel}`);
  }

  return {
    level: highestLevel(levels),
    scopes: sortedScopes(scopes),
    files,
    reasons,
  };
}

export function planCiChecks(classification: CiClassification): CiCheckPlan {
  const scopes = new Set(classification.scopes);
  const hasChanges = classification.files.length > 0 || classification.reasons.length > 0;
  const release = classification.level === "L3";
  const appBaseline = release
    || classification.level === "L1"
    || scopes.has("app")
    || scopes.has("build")
    || scopes.has("ci")
    || scopes.has("unknown");
  const fullBrowser = release || scopes.has("browser");

  return {
    documentation: hasChanges && (release || classification.level === "L0" || scopes.has("docs") || scopes.has("generated-docs")),
    privacy: hasChanges,
    releaseRecord: hasChanges && scopes.has("release-record"),
    lint: appBaseline,
    typecheck: appBaseline,
    unit: appBaseline,
    chromiumSmoke: appBaseline && !fullBrowser,
    chromiumFull: fullBrowser,
    webkitFull: fullBrowser,
    productionBuild: release || scopes.has("build") || scopes.has("unknown"),
    windowsCore: release || scopes.has("windows"),
    macosFull: release || scopes.has("macos"),
    databaseUpgrade: release || scopes.has("database"),
    contractCheck: release || scopes.has("contract"),
    ciPolicy: release || scopes.has("ci"),
    privacyHistory: release,
    release,
  };
}

export function planCiExecution(
  checks: CiCheckPlan,
  productEvidenceInherited: boolean,
): CiCheckPlan {
  if (!productEvidenceInherited) return checks;

  return {
    ...checks,
    lint: false,
    typecheck: false,
    unit: false,
    chromiumSmoke: false,
    chromiumFull: false,
    webkitFull: false,
    productionBuild: false,
    windowsCore: false,
    macosFull: false,
    databaseUpgrade: false,
    contractCheck: false,
    ciPolicy: false,
    privacyHistory: false,
    release: false,
  };
}

export function decideProductEvidenceInheritance(
  input: ProductEvidenceInput,
): ProductEvidenceDecision {
  const cumulativeClassification = classifyCiChanges(input.cumulativeChanges);
  const productVerifiedSha = input.productVerifiedSha?.trim();

  if (!productVerifiedSha) {
    return {
      canInherit: false,
      productVerifiedShaCandidate: cumulativeClassification.level === "L0" ? "" : input.headSha,
      reason: "missing",
      cumulativeClassification,
    };
  }

  if (productVerifiedSha === input.headSha) {
    return {
      canInherit: true,
      productVerifiedShaCandidate: productVerifiedSha,
      reason: "current",
      cumulativeClassification,
    };
  }

  if (!input.productVerifiedShaIsAncestor) {
    return {
      canInherit: false,
      productVerifiedShaCandidate: cumulativeClassification.level === "L0" ? "" : input.headSha,
      reason: "not-ancestor",
      cumulativeClassification,
    };
  }

  if (cumulativeClassification.level === "L0") {
    return {
      canInherit: true,
      productVerifiedShaCandidate: productVerifiedSha,
      reason: "docs-only-descendant",
      cumulativeClassification,
    };
  }

  return {
    canInherit: false,
    productVerifiedShaCandidate: input.headSha,
    reason: "product-changed",
    cumulativeClassification,
  };
}

export function parseGitNameStatus(output: string): ChangedPath[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes: ChangedPath[] = [];

  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) break;
    if (status.startsWith("R") || status.startsWith("C")) {
      const previousPath = fields[index++];
      const path = fields[index++];
      if (previousPath && path) changes.push({ status, previousPath, path });
      continue;
    }

    const path = fields[index++];
    if (path) changes.push({ status, path });
  }

  return changes;
}
