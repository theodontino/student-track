import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const EVIDENCE_PATTERN = /^Product evidence \| product=([0-9a-f]{40}) \| base=([0-9a-f]{40}|none) \| level=(L[0-3]) \| scopes=([a-z0-9,_-]+)$/;

type GithubEvent = {
  after?: string;
  before?: string;
  pull_request?: {
    base?: { sha?: string };
    head?: { sha?: string };
  };
  merge_group?: {
    base_sha?: string;
    head_sha?: string;
  };
};

type CheckRun = {
  app?: { slug?: string };
  completed_at?: string;
  conclusion?: string;
  details_url?: string;
  name?: string;
  status?: string;
};

type WorkflowRun = {
  id?: number;
  conclusion?: string;
  event?: string;
  head_repository?: { full_name?: string };
  head_sha?: string;
  path?: string;
  status?: string;
};

type GitCommit = {
  sha?: string;
  tree?: { sha?: string };
};

type CompareResult = {
  merge_base_commit?: { sha?: string };
  status?: string;
};

type Artifact = {
  expired?: boolean;
  name?: string;
};

type WorkflowJob = {
  conclusion?: string;
  name?: string;
  status?: string;
};

type EvidenceMarker = {
  checkName: string;
  productSha: string;
  baseSha: string;
  level: string;
  scopes: string;
  completedAt: string;
  detailsUrl: string;
};

export type TreeEquivalentEvidenceCandidate = {
  artifactNames: string[];
  baseIsAncestor: boolean;
  baseSha: string;
  conclusion: string;
  event: string;
  headTreeSha: string;
  level: string;
  markerRunId: string;
  productSha: string;
  repository: string;
  runId: string;
  status: string;
  workflowPath: string;
};

export type TreeEquivalentEvidence = {
  macosArtifact: string;
  sourceProductSha: string;
  sourceRunId: string;
  windowsArtifact: string;
};

export function selectTreeEquivalentEvidence(input: {
  baseSha: string;
  currentParents: string[];
  currentTreeSha: string;
  repository: string;
  candidates: TreeEquivalentEvidenceCandidate[];
}): TreeEquivalentEvidence | undefined {
  if (input.currentParents.length !== 1 || input.currentParents[0] !== input.baseSha) {
    return undefined;
  }

  for (const candidate of input.candidates) {
    const windowsArtifact = `student-track-core-windows-x64-${candidate.productSha}`;
    const macosArtifact = `student-track-full-macos-${candidate.productSha}`;
    if (
      candidate.repository === input.repository
      && candidate.event === "pull_request"
      && candidate.status === "completed"
      && candidate.conclusion === "success"
      && candidate.workflowPath === ".github/workflows/ci.yml"
      && candidate.markerRunId === candidate.runId
      && candidate.level === "L3"
      && candidate.baseSha === input.baseSha
      && candidate.baseIsAncestor
      && candidate.headTreeSha === input.currentTreeSha
      && candidate.artifactNames.includes(windowsArtifact)
      && candidate.artifactNames.includes(macosArtifact)
    ) {
      return {
        sourceRunId: candidate.runId,
        sourceProductSha: candidate.productSha,
        windowsArtifact,
        macosArtifact,
      };
    }
  }
  return undefined;
}

function appendGithubOutputs(values: Record<string, string | boolean>) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  const lines = Object.entries(values).map(([name, value]) => `${name}=${String(value)}`);
  fs.appendFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
}

function normalizeSha(value: unknown) {
  return typeof value === "string" && SHA_PATTERN.test(value) ? value : "";
}

function resolveCommit(revision: string) {
  if (!normalizeSha(revision)) return "";
  try {
    return execFileSync("git", ["rev-parse", "--verify", `${revision}^{commit}`], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

function isAncestor(ancestorSha: string, headSha: string) {
  return spawnSync("git", ["merge-base", "--is-ancestor", ancestorSha, headSha], {
    stdio: "ignore",
  }).status === 0;
}

function ancestorCommits(revision: string) {
  try {
    return execFileSync("git", ["rev-list", "--max-count=100", revision], {
      encoding: "utf8",
    })
      .split("\n")
      .map((value) => value.trim())
      .filter((value) => SHA_PATTERN.test(value));
  } catch {
    return [];
  }
}

function commitTree(revision: string) {
  try {
    return execFileSync("git", ["rev-parse", `${revision}^{tree}`], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function commitParents(revision: string) {
  try {
    return execFileSync("git", ["rev-list", "--parents", "-n", "1", revision], {
      encoding: "utf8",
    }).trim().split(/\s+/).slice(1).filter((value) => SHA_PATTERN.test(value));
  } catch {
    return [];
  }
}

function readEvent(): GithubEvent {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return {};
  return JSON.parse(fs.readFileSync(eventPath, "utf8"));
}

function resolveContext(event: GithubEvent) {
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  const pullRequest = event.pull_request ?? {};
  const mergeGroup = event.merge_group ?? {};
  const headSha = normalizeSha(
    pullRequest.head?.sha
      ?? mergeGroup.head_sha
      ?? event.after
      ?? process.env.GITHUB_SHA,
  );
  const baseSha = normalizeSha(
    pullRequest.base?.sha
      ?? mergeGroup.base_sha
      ?? event.before,
  );

  let evidenceRefSha = "";
  if (eventName === "pull_request") {
    evidenceRefSha = normalizeSha(event.before) || baseSha;
  } else if (eventName === "merge_group") {
    evidenceRefSha = baseSha;
  } else if (eventName === "push" && !String(process.env.GITHUB_REF).startsWith("refs/tags/")) {
    evidenceRefSha = normalizeSha(event.before);
  }

  return { eventName, headSha, baseSha, evidenceRefSha };
}

function markerFromCheck(check: CheckRun): EvidenceMarker | undefined {
  if (check?.status !== "completed" || check?.conclusion !== "success") return undefined;
  if (check?.app?.slug !== "github-actions") return undefined;
  const checkName = String(check.name ?? "");
  return markerFromName(checkName, {
    completedAt: check.completed_at ?? "",
    detailsUrl: String(check.details_url ?? ""),
  });
}

function markerFromName(
  checkName: string,
  metadata: { completedAt?: string; detailsUrl?: string } = {},
): EvidenceMarker | undefined {
  const match = checkName.match(EVIDENCE_PATTERN);
  if (!match) return undefined;
  return {
    checkName,
    productSha: match[1],
    baseSha: match[2] === "none" ? "" : match[2],
    level: match[3],
    scopes: match[4],
    completedAt: metadata.completedAt ?? "",
    detailsUrl: metadata.detailsUrl ?? "",
  };
}

async function listCheckRuns(refSha: string): Promise<CheckRun[]> {
  const repository = process.env.GITHUB_REPOSITORY;
  const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
  if (!repository) return [];
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "student-track-ci-policy",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(
    `${apiUrl}/repos/${repository}/commits/${refSha}/check-runs?filter=latest&per_page=100`,
    { headers },
  );
  if (!response.ok) {
    throw new Error(`Checks API returned ${response.status}`);
  }
  const payload = await response.json() as { check_runs?: CheckRun[] };
  return Array.isArray(payload.check_runs) ? payload.check_runs : [];
}

function workflowRunId(detailsUrl: string) {
  const repositoryUrl = `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY}/actions/runs/`;
  if (!detailsUrl.startsWith(repositoryUrl)) return "";
  const runId = detailsUrl.slice(repositoryUrl.length).split("/", 1)[0];
  return /^\d+$/.test(runId) ? runId : "";
}

async function getWorkflowRun(runId: string): Promise<WorkflowRun> {
  const repository = process.env.GITHUB_REPOSITORY;
  const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
  if (!repository || !runId) return {};
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "student-track-ci-policy",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${apiUrl}/repos/${repository}/actions/runs/${runId}`, { headers });
  if (!response.ok) throw new Error(`Actions API returned ${response.status}`);
  return await response.json() as WorkflowRun;
}

async function githubJson<T>(path: string): Promise<T> {
  const repository = process.env.GITHUB_REPOSITORY;
  const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
  if (!repository) throw new Error("GITHUB_REPOSITORY is not set");
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "student-track-ci-policy",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${apiUrl}/repos/${repository}${path}`, { headers });
  if (!response.ok) throw new Error(`GitHub API ${path} returned ${response.status}`);
  return await response.json() as T;
}

async function listSuccessfulPullRequestRuns() {
  const payload = await githubJson<{ workflow_runs?: WorkflowRun[] }>(
    "/actions/workflows/ci.yml/runs?event=pull_request&status=success&per_page=20",
  );
  return Array.isArray(payload.workflow_runs) ? payload.workflow_runs : [];
}

async function getGitCommit(sha: string) {
  return githubJson<GitCommit>(`/git/commits/${sha}`);
}

async function compareCommits(baseSha: string, headSha: string) {
  return githubJson<CompareResult>(`/compare/${baseSha}...${headSha}`);
}

async function listArtifacts(runId: string) {
  const payload = await githubJson<{ artifacts?: Artifact[] }>(
    `/actions/runs/${runId}/artifacts?per_page=100`,
  );
  return Array.isArray(payload.artifacts) ? payload.artifacts : [];
}

async function listWorkflowJobs(runId: string) {
  const payload = await githubJson<{ jobs?: WorkflowJob[] }>(
    `/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
  );
  return Array.isArray(payload.jobs) ? payload.jobs : [];
}

async function findTreeEquivalentEvidence(context: ReturnType<typeof resolveContext>) {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const currentTreeSha = commitTree(context.headSha);
  const currentParents = commitParents(context.headSha);
  if (
    context.eventName !== "push"
    || String(process.env.GITHUB_REF).startsWith("refs/tags/")
    || !repository
    || !currentTreeSha
    || !context.baseSha
  ) {
    return undefined;
  }

  const candidates: TreeEquivalentEvidenceCandidate[] = [];
  for (const run of await listSuccessfulPullRequestRuns()) {
    const runId = Number.isInteger(run.id) ? String(run.id) : "";
    const productSha = normalizeSha(run.head_sha);
    if (
      !runId
      || !productSha
      || run.head_repository?.full_name !== repository
      || run.path !== ".github/workflows/ci.yml"
      || run.event !== "pull_request"
      || run.status !== "completed"
      || run.conclusion !== "success"
    ) {
      continue;
    }

    let marker: EvidenceMarker | undefined;
    let commit: GitCommit;
    let comparison: CompareResult;
    let artifacts: Artifact[];
    try {
      const [jobs, resolvedCommit, resolvedComparison, resolvedArtifacts] = await Promise.all([
        listWorkflowJobs(runId),
        getGitCommit(productSha),
        compareCommits(context.baseSha, productSha),
        listArtifacts(runId),
      ]);
      marker = jobs
        .filter((job) => job.status === "completed" && job.conclusion === "success")
        .map((job) => markerFromName(String(job.name ?? "")))
        .filter((candidate): candidate is EvidenceMarker => Boolean(candidate))
        .find((candidate) => (
          candidate.productSha === productSha
          && candidate.baseSha === context.baseSha
          && candidate.level === "L3"
        ));
      commit = resolvedCommit;
      comparison = resolvedComparison;
      artifacts = resolvedArtifacts;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Skipping CI run ${runId}: ${message}`);
      continue;
    }
    if (!marker) continue;

    candidates.push({
      artifactNames: artifacts
        .filter((artifact) => !artifact.expired)
        .map((artifact) => String(artifact.name ?? ""))
        .filter(Boolean),
      baseIsAncestor: comparison.merge_base_commit?.sha === context.baseSha
        && ["ahead", "identical"].includes(String(comparison.status)),
      baseSha: marker.baseSha,
      conclusion: String(run.conclusion ?? ""),
      event: String(run.event ?? ""),
      headTreeSha: normalizeSha(commit.tree?.sha),
      level: marker.level,
      markerRunId: runId,
      productSha,
      repository: String(run.head_repository?.full_name ?? ""),
      runId,
      status: String(run.status ?? ""),
      workflowPath: String(run.path ?? ""),
    });
  }

  return selectTreeEquivalentEvidence({
    baseSha: context.baseSha,
    currentParents,
    currentTreeSha,
    repository,
    candidates,
  });
}

async function isTrustedWorkflowRun(marker: EvidenceMarker, evidenceRefSha: string) {
  const runId = workflowRunId(marker.detailsUrl);
  if (!runId) return false;
  const run = await getWorkflowRun(runId);
  return run.status === "completed"
    && run.conclusion === "success"
    && run.head_sha === evidenceRefSha
    && run.path === ".github/workflows/ci.yml"
    && ["pull_request", "push", "merge_group", "workflow_dispatch"].includes(String(run.event));
}

async function main() {
  const event = readEvent();
  const context = resolveContext(event);
  const evidenceRefSha = resolveCommit(context.evidenceRefSha);
  const result = {
    evidence_found: false,
    evidence_ref_sha: evidenceRefSha,
    prior_product_verified_sha: "",
    evidence_check_name: "",
    tree_equivalent_evidence: false,
    tree_equivalent_source_run_id: "",
    tree_equivalent_source_product_sha: "",
    tree_equivalent_windows_artifact: "",
    tree_equivalent_macos_artifact: "",
  };

  if (!context.headSha || !evidenceRefSha || !isAncestor(evidenceRefSha, context.headSha)) {
    appendGithubOutputs(result);
    console.log("No eligible ancestor check ref; strict L0 cannot inherit product evidence.");
    return;
  }

  try {
    const equivalent = await findTreeEquivalentEvidence(context);
    if (equivalent) {
      result.evidence_found = true;
      result.prior_product_verified_sha = context.headSha;
      result.evidence_check_name = "same-tree L3 pull request evidence";
      result.tree_equivalent_evidence = true;
      result.tree_equivalent_source_run_id = equivalent.sourceRunId;
      result.tree_equivalent_source_product_sha = equivalent.sourceProductSha;
      result.tree_equivalent_windows_artifact = equivalent.windowsArtifact;
      result.tree_equivalent_macos_artifact = equivalent.macosArtifact;
      appendGithubOutputs(result);
      console.log(
        `Same-tree L3 evidence found in run ${equivalent.sourceRunId}; current HEAD can reuse product checks.`,
      );
      return;
    }

    let marker: EvidenceMarker | undefined;
    for (const candidateRefSha of ancestorCommits(evidenceRefSha)) {
      const checks = await listCheckRuns(candidateRefSha);
      const markers = checks
        .map(markerFromCheck)
        .filter((candidate): candidate is EvidenceMarker => Boolean(candidate))
        .filter((candidate) => isAncestor(candidate.productSha, context.headSha))
        .filter((candidate) => (
          context.eventName !== "pull_request"
          || evidenceRefSha === context.baseSha
          || candidate.baseSha === context.baseSha
        ))
        .sort((left, right) => right.completedAt.localeCompare(left.completedAt));
      for (const candidate of markers) {
        if (await isTrustedWorkflowRun(candidate, candidateRefSha)) {
          marker = candidate;
          break;
        }
      }
      if (marker) break;
    }
    if (marker) {
      result.evidence_found = true;
      result.prior_product_verified_sha = marker.productSha;
      result.evidence_check_name = marker.checkName;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Product evidence lookup unavailable: ${message}`);
  }

  appendGithubOutputs(result);
  if (result.evidence_found) {
    console.log(`Product evidence found on ${evidenceRefSha}: ${result.evidence_check_name}`);
  } else {
    console.log(`No reusable product evidence found on ${evidenceRefSha}; strict L0 will fail closed.`);
  }
}

if (process.env.NODE_ENV !== "test") {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
