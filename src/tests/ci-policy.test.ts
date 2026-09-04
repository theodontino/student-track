import { describe, expect, it } from "vitest";
import {
  classifyCiChanges,
  decideProductEvidenceInheritance,
  parseGitNameStatus,
  planCiChecks,
  planCiExecution,
  type ChangedPath,
} from "../../scripts/ci-policy";

describe("CI change classification", () => {
  it.each([
    "README.md",
    "AGENTS.md",
    "LICENSE",
    "docs/DOMAIN.md",
    "docs/generated/ROUTES.md",
    "docs/contracts/README.md",
    "OLD/2026-06-04/流程.md",
    ".github/ISSUE_TEMPLATE/bug.yml",
  ])("keeps the strict documentation allowlist at L0: %s", (path) => {
    const result = classifyCiChanges([{ path }]);

    expect(result.level).toBe("L0");
    expect(result.scopes).toContain("docs");
    expect(planCiChecks(result)).toMatchObject({
      documentation: true,
      privacy: true,
      lint: false,
      chromiumSmoke: false,
      productionBuild: false,
      windowsCore: false,
    });
  });

  it("marks release evidence as documentation without turning it into a release build", () => {
    const result = classifyCiChanges([{ path: "docs/release-evidence/1.3.0-beta.2.md" }]);

    expect(result).toMatchObject({ level: "L0" });
    expect(result.scopes).toEqual(["docs", "release-record"]);
    expect(planCiChecks(result)).toMatchObject({ releaseRecord: true, release: false });
  });

  it.each([
    ["notes.md", "L2", "unknown"],
    [".github/workflows/ci.yml", "L2", "ci"],
    ["scripts/ci-policy.ts", "L2", "ci"],
    ["scripts/resolve-ci-evidence.ts", "L2", "ci"],
    ["docs/contracts/wcc-student-track-file-v1.schema.json", "L3", "contract"],
  ] as const)("does not let %s enter the documentation allowlist", (path, level, scope) => {
    const result = classifyCiChanges([{ path }]);

    expect(result.level).toBe(level);
    expect(result.scopes).toContain(scope);
  });

  it("uses the L1 application baseline for an ordinary API route and checks generated docs", () => {
    const result = classifyCiChanges([{ path: "src/app/api/semesters/route.ts" }]);
    const plan = planCiChecks(result);

    expect(result).toMatchObject({ level: "L1", scopes: ["generated-docs", "app"] });
    expect(plan).toMatchObject({
      documentation: true,
      lint: true,
      typecheck: true,
      unit: true,
      chromiumSmoke: true,
      chromiumFull: false,
      webkitFull: false,
      windowsCore: false,
    });
  });

  it("runs the full browser scope for browser-sensitive presentation", () => {
    const result = classifyCiChanges([{ path: "src/features/feedback/workbench.module.css" }]);
    const plan = planCiChecks(result);

    expect(result).toMatchObject({ level: "L2", scopes: ["app", "browser"] });
    expect(plan).toMatchObject({
      lint: true,
      unit: true,
      chromiumSmoke: false,
      chromiumFull: true,
      webkitFull: true,
    });
  });

  it("keeps Windows-only changes away from unrelated browser and macOS jobs", () => {
    const result = classifyCiChanges([{ path: "scripts/windows/Start-StudentTrackCore.ps1" }]);
    const plan = planCiChecks(result);

    expect(result).toMatchObject({ level: "L2", scopes: ["windows"] });
    expect(plan).toMatchObject({
      windowsCore: true,
      macosFull: false,
      chromiumFull: false,
      webkitFull: false,
      lint: false,
    });
  });

  it("keeps macOS-only runtime changes away from Windows and browser jobs", () => {
    const result = classifyCiChanges([{ path: "scripts/macos/Install-StudentTrackFullOffline.sh" }]);
    const plan = planCiChecks(result);

    expect(result).toMatchObject({ level: "L2", scopes: ["macos"] });
    expect(plan).toMatchObject({
      windowsCore: false,
      macosFull: true,
      chromiumFull: false,
      webkitFull: false,
      lint: false,
    });
  });

  it("routes platform bundle workflows to their matching platform", () => {
    const windows = classifyCiChanges([{ path: ".github/workflows/windows-offline-package.yml" }]);
    const macos = classifyCiChanges([{ path: ".github/workflows/macos-offline-package.yml" }]);

    expect(windows).toMatchObject({ level: "L2", scopes: ["windows", "ci"] });
    expect(macos).toMatchObject({ level: "L2", scopes: ["macos", "ci"] });
    expect(planCiChecks(windows)).toMatchObject({ windowsCore: true, macosFull: false });
    expect(planCiChecks(macos)).toMatchObject({ windowsCore: false, macosFull: true });
  });

  it("validates every platform controlled by the main CI workflow", () => {
    const result = classifyCiChanges([{ path: ".github/workflows/ci.yml" }]);
    const plan = planCiChecks(result);

    expect(result).toMatchObject({
      level: "L2",
      scopes: ["browser", "build", "windows", "macos", "ci"],
    });
    expect(plan).toMatchObject({
      lint: true,
      typecheck: true,
      unit: true,
      chromiumFull: true,
      webkitFull: true,
      productionBuild: true,
      windowsCore: true,
      macosFull: true,
      ciPolicy: true,
    });
  });

  it("uses a common baseline and production build for unknown L2 paths", () => {
    const plan = planCiChecks(classifyCiChanges([{ path: "notes.md" }]));

    expect(plan).toMatchObject({
      lint: true,
      typecheck: true,
      unit: true,
      chromiumSmoke: true,
      productionBuild: true,
    });
  });

  it("treats dependency resolution as cross-platform build-sensitive work", () => {
    const result = classifyCiChanges([{ path: "package-lock.json" }]);

    expect(result).toMatchObject({ level: "L2", scopes: ["build", "windows", "macos"] });
    expect(planCiChecks(result)).toMatchObject({
      productionBuild: true,
      windowsCore: true,
      macosFull: true,
    });
  });

  it.each([
    "prisma/schema.prisma",
    "prisma/migrations/20260904090000_example/migration.sql",
    "prisma/seed.ts",
    "scripts/db-restore.ts",
  ])("uses L3 for database and recovery boundaries: %s", (path) => {
    const result = classifyCiChanges([{ path }]);

    expect(result.level).toBe("L3");
    expect(result.scopes).toContain("database");
    expect(planCiChecks(result)).toMatchObject({
      release: true,
      windowsCore: true,
      macosFull: true,
      chromiumFull: true,
      webkitFull: true,
      databaseUpgrade: true,
    });
  });

  it("takes the highest level and the union of scopes for a mixed change", () => {
    const result = classifyCiChanges([
      { path: "docs/OPERATIONS.md" },
      { path: "src/services/semester-service.ts" },
    ]);

    expect(result.level).toBe("L1");
    expect(result.scopes).toEqual(["docs", "app"]);
  });

  it("classifies both sides of a rename so a product deletion cannot look docs-only", () => {
    const result = classifyCiChanges([{
      status: "R100",
      previousPath: "src/lib/product-changelog.ts",
      path: "docs/product-changelog.md",
    }]);

    expect(result.level).toBe("L1");
    expect(result.scopes).toEqual(["docs", "app"]);
  });

  it("raises but never lowers classification through explicit facts", () => {
    const release = classifyCiChanges(
      [{ path: "docs/README.md" }],
      { productVersionChanged: true },
    );
    const forcedBrowser = classifyCiChanges(
      [{ path: "docs/README.md" }],
      { forceLevel: "L1", forceScopes: ["browser"] },
    );

    expect(release).toMatchObject({ level: "L3" });
    expect(release.scopes).toContain("release");
    expect(forcedBrowser.level).toBe("L2");
    expect(forcedBrowser.scopes).toContain("browser");
  });
});

describe("Git name-status parsing", () => {
  it("preserves both paths of a rename", () => {
    const changes = parseGitNameStatus([
      "R100",
      "src/lib/product-changelog.ts",
      "docs/product-changelog.md",
      "M",
      "README.md",
      "",
    ].join("\0"));

    expect(changes).toEqual<ChangedPath[]>([
      {
        status: "R100",
        previousPath: "src/lib/product-changelog.ts",
        path: "docs/product-changelog.md",
      },
      { status: "M", path: "README.md" },
    ]);
  });
});

describe("product verification evidence", () => {
  it("fails closed when an L0 change has no trusted product evidence", () => {
    const decision = decideProductEvidenceInheritance({
      headSha: "head",
      productVerifiedShaIsAncestor: false,
      cumulativeChanges: [{ path: "docs/OPERATIONS.md" }],
    });

    expect(decision).toMatchObject({
      canInherit: false,
      productVerifiedShaCandidate: "",
      reason: "missing",
    });
  });

  it("does not rerun product jobs when trusted evidence is inherited", () => {
    const required = planCiChecks(classifyCiChanges([
      { path: "src/services/semester-service.ts" },
      { path: "docs/OPERATIONS.md" },
    ]));
    const execution = planCiExecution(required, true);

    expect(required).toMatchObject({ lint: true, unit: true, chromiumSmoke: true });
    expect(execution).toMatchObject({
      documentation: true,
      privacy: true,
      lint: false,
      unit: false,
      chromiumSmoke: false,
      chromiumFull: false,
      webkitFull: false,
      productionBuild: false,
      windowsCore: false,
      macosFull: false,
      release: false,
    });
  });

  it("inherits an ancestor's product evidence across cumulative L0 changes", () => {
    const decision = decideProductEvidenceInheritance({
      headSha: "head",
      productVerifiedSha: "product",
      productVerifiedShaIsAncestor: true,
      cumulativeChanges: [
        { path: "docs/OPERATIONS.md" },
        { path: "README.md" },
      ],
    });

    expect(decision).toMatchObject({
      canInherit: true,
      productVerifiedShaCandidate: "product",
      reason: "docs-only-descendant",
    });
  });

  it("does not inherit when cumulative history contains a product change", () => {
    const decision = decideProductEvidenceInheritance({
      headSha: "head",
      productVerifiedSha: "product",
      productVerifiedShaIsAncestor: true,
      cumulativeChanges: [
        { path: "src/services/semester-service.ts" },
        { path: "docs/OPERATIONS.md" },
      ],
    });

    expect(decision).toMatchObject({
      canInherit: false,
      productVerifiedShaCandidate: "head",
      reason: "product-changed",
    });
  });

  it("rejects a non-ancestor and leaves no candidate for an unverified docs-only tail", () => {
    const decision = decideProductEvidenceInheritance({
      headSha: "head",
      productVerifiedSha: "other-line",
      productVerifiedShaIsAncestor: false,
      cumulativeChanges: [{ path: "docs/OPERATIONS.md" }],
    });

    expect(decision).toMatchObject({
      canInherit: false,
      productVerifiedShaCandidate: "",
      reason: "not-ancestor",
    });
  });

  it("accepts evidence already attached to HEAD", () => {
    const decision = decideProductEvidenceInheritance({
      headSha: "head",
      productVerifiedSha: "head",
      productVerifiedShaIsAncestor: true,
      cumulativeChanges: [],
    });

    expect(decision).toMatchObject({
      canInherit: true,
      productVerifiedShaCandidate: "head",
      reason: "current",
    });
  });
});
