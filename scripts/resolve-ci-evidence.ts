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
  conclusion?: string;
  event?: string;
  head_sha?: string;
  path?: string;
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
  const match = checkName.match(EVIDENCE_PATTERN);
  if (!match) return undefined;
  return {
    checkName,
    productSha: match[1],
    baseSha: match[2] === "none" ? "" : match[2],
    level: match[3],
    scopes: match[4],
    completedAt: check.completed_at ?? "",
    detailsUrl: String(check.details_url ?? ""),
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
  };

  if (!context.headSha || !evidenceRefSha || !isAncestor(evidenceRefSha, context.headSha)) {
    appendGithubOutputs(result);
    console.log("No eligible ancestor check ref; strict L0 cannot inherit product evidence.");
    return;
  }

  try {
    const checks = await listCheckRuns(evidenceRefSha);
    const markers = checks
      .map(markerFromCheck)
      .filter((marker): marker is EvidenceMarker => Boolean(marker))
      .filter((marker) => isAncestor(marker.productSha, context.headSha))
      .filter((marker) => (
        context.eventName !== "pull_request"
        || evidenceRefSha === context.baseSha
        || marker.baseSha === context.baseSha
      ))
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt));
    let marker: EvidenceMarker | undefined;
    for (const candidate of markers) {
      if (await isTrustedWorkflowRun(candidate, evidenceRefSha)) {
        marker = candidate;
        break;
      }
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

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
