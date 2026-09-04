import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import {
  CI_LEVELS,
  CI_SCOPES,
  classifyCiChanges,
  decideProductEvidenceInheritance,
  parseGitNameStatus,
  planCiChecks,
  planCiExecution,
  type ChangedPath,
  type CiClassificationFacts,
  type CiLevel,
  type CiScope,
} from "./ci-policy";

type CliOptions = {
  base?: string;
  head: string;
  productVerifiedSha?: string;
  forceLevel?: CiLevel;
  forceScopes: CiScope[];
  productVersionChanged?: boolean;
};

function git(args: string[]) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function resolveCommit(revision: string) {
  return git(["rev-parse", "--verify", `${revision}^{commit}`]);
}

function tryResolveCommit(revision: string | undefined) {
  if (!revision || /^0+$/.test(revision)) return undefined;
  try {
    return resolveCommit(revision);
  } catch {
    return undefined;
  }
}

function mergeBase(baseSha: string, headSha: string) {
  return git(["merge-base", baseSha, headSha]);
}

function diffChanges(baseSha: string, headSha: string, useMergeBase: boolean): ChangedPath[] {
  const range = useMergeBase ? `${baseSha}...${headSha}` : `${baseSha}..${headSha}`;
  const output = execFileSync(
    "git",
    ["diff", "--name-status", "-z", "--find-renames", range],
    { encoding: "utf8" },
  );
  return parseGitNameStatus(output);
}

function rootChanges(headSha: string) {
  const output = execFileSync(
    "git",
    ["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-z", "--find-renames", headSha],
    { encoding: "utf8" },
  );
  return parseGitNameStatus(output);
}

function isAncestor(ancestorSha: string, headSha: string) {
  return spawnSync("git", ["merge-base", "--is-ancestor", ancestorSha, headSha], {
    stdio: "ignore",
  }).status === 0;
}

function packageVersionAt(revision: string) {
  try {
    const contents = execFileSync("git", ["show", `${revision}:package.json`], { encoding: "utf8" });
    return (JSON.parse(contents) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

function parseLevel(value: string | undefined, option: string): CiLevel | undefined {
  if (!value) return undefined;
  if ((CI_LEVELS as readonly string[]).includes(value)) return value as CiLevel;
  throw new Error(`${option} must be one of ${CI_LEVELS.join(", ")}`);
}

function parseScopes(values: string[]) {
  const scopes = values.flatMap((value) => value.split(",")).filter(Boolean);
  for (const scope of scopes) {
    if (!(CI_SCOPES as readonly string[]).includes(scope)) {
      throw new Error(`--force-scope must be one of ${CI_SCOPES.join(", ")}`);
    }
  }
  return [...new Set(scopes)] as CiScope[];
}

function parseBoolean(value: string | undefined) {
  if (value === undefined) return undefined;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new Error("--product-version-changed must be true or false");
}

function parseOptions(argv: string[]): CliOptions {
  let base = process.env.CI_BASE_SHA;
  let head = process.env.CI_HEAD_SHA ?? "HEAD";
  let productVerifiedSha = process.env.PRODUCT_VERIFIED_SHA;
  let forceLevelValue = process.env.CI_FORCE_LEVEL;
  const forceScopeValues = process.env.CI_FORCE_SCOPES ? [process.env.CI_FORCE_SCOPES] : [];
  let productVersionChangedValue = process.env.CI_PRODUCT_VERSION_CHANGED;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--base" && value) {
      base = value;
      index += 1;
    } else if (argument === "--head" && value) {
      head = value;
      index += 1;
    } else if (argument === "--product-verified-sha" && value) {
      productVerifiedSha = value;
      index += 1;
    } else if (argument === "--force-level" && value) {
      forceLevelValue = value;
      index += 1;
    } else if (argument === "--force-scope" && value) {
      forceScopeValues.push(value);
      index += 1;
    } else if (argument === "--product-version-changed" && value) {
      productVersionChangedValue = value;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
  }

  return {
    base,
    head,
    productVerifiedSha,
    forceLevel: parseLevel(forceLevelValue, "--force-level"),
    forceScopes: parseScopes(forceScopeValues),
    productVersionChanged: parseBoolean(productVersionChangedValue),
  };
}

function appendGithubOutputs(values: Record<string, string | boolean>) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  const lines = Object.entries(values).map(([name, value]) => `${name}=${String(value)}`);
  fs.appendFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
}

function checkOutputName(name: string) {
  return `run_${name.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`)}`;
}

function main() {
  const options = parseOptions(process.argv.slice(2));
  const headSha = resolveCommit(options.head);
  const validatedSha = tryResolveCommit(process.env.CI_VALIDATED_SHA) ?? headSha;
  const suppliedBaseSha = tryResolveCommit(options.base);
  const parentSha = suppliedBaseSha ? undefined : tryResolveCommit(`${headSha}^`);
  const baseSha = suppliedBaseSha ?? parentSha;
  const diffBaseSha = suppliedBaseSha ? mergeBase(suppliedBaseSha, headSha) : parentSha;
  const changes = baseSha ? diffChanges(baseSha, headSha, Boolean(suppliedBaseSha)) : rootChanges(headSha);

  const touchesPackageJson = changes.some((change) => (
    change.path === "package.json" || change.previousPath === "package.json"
  ));
  const detectedProductVersionChanged = Boolean(
    touchesPackageJson
    && diffBaseSha
    && packageVersionAt(diffBaseSha) !== packageVersionAt(headSha),
  );
  const facts: CiClassificationFacts = {
    productVersionChanged: options.productVersionChanged ?? detectedProductVersionChanged,
    forceLevel: options.forceLevel,
    forceScopes: options.forceScopes,
  };
  const classification = classifyCiChanges(changes, facts);
  const checks = planCiChecks(classification);

  const productVerifiedSha = tryResolveCommit(options.productVerifiedSha);
  const productVerifiedShaIsAncestor = Boolean(
    productVerifiedSha && isAncestor(productVerifiedSha, headSha),
  );
  const cumulativeChanges = productVerifiedSha && productVerifiedShaIsAncestor
    ? diffChanges(productVerifiedSha, headSha, false)
    : [];
  const evidence = decideProductEvidenceInheritance({
    headSha,
    productVerifiedSha,
    productVerifiedShaIsAncestor,
    cumulativeChanges,
  });
  const executionChecks = planCiExecution(checks, evidence.canInherit);
  const productVerifiedShaCandidate = evidence.canInherit
    ? evidence.productVerifiedShaCandidate
    : classification.level === "L0"
      ? ""
      : headSha;
  const evidenceCandidateSha = productVerifiedSha ?? diffBaseSha ?? "";
  const allowInheritance = evidence.canInherit;
  const runL1 = executionChecks.lint
    || executionChecks.typecheck
    || executionChecks.unit
    || executionChecks.chromiumSmoke;
  const runBrowserFull = executionChecks.chromiumFull || executionChecks.webkitFull;

  const result = {
    baseSha: diffBaseSha ?? null,
    headSha,
    productVerifiedSha: productVerifiedSha ?? null,
    productVerifiedShaCandidate: productVerifiedShaCandidate || null,
    evidenceCandidateSha: evidenceCandidateSha || null,
    allowInheritance,
    productEvidenceInherited: evidence.canInherit,
    productEvidenceReason: evidence.reason,
    changes,
    classification,
    checks,
    executionChecks,
  };
  const compactResult = JSON.stringify(result);
  const githubOutputs: Record<string, string | boolean> = {
    head_sha: headSha,
    base_sha: diffBaseSha ?? "",
    validated_sha: validatedSha,
    level: classification.level,
    scopes: JSON.stringify(classification.scopes),
    changed_paths: JSON.stringify(changes),
    classification: JSON.stringify(classification),
    plan: JSON.stringify(checks),
    product_verified_sha_candidate: productVerifiedShaCandidate,
    evidence_candidate_sha: evidenceCandidateSha,
    allow_inheritance: allowInheritance,
    product_evidence_inherited: evidence.canInherit,
    product_evidence_reason: evidence.reason,
    run_docs: checks.documentation,
    run_l1: runL1,
    run_browser_full: runBrowserFull,
    run_windows: checks.windowsCore,
    run_mac: checks.macosFull,
    run_release: checks.release,
    result_json: compactResult,
  };
  for (const [name, enabled] of Object.entries(executionChecks)) {
    githubOutputs[checkOutputName(name)] = enabled;
  }
  appendGithubOutputs(githubOutputs);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
