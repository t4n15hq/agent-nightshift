import type { WorkerConfig } from "./config";
import { runCommand, type CommandResult } from "./git";
import { getLabelDefinitions, issueStateLabels } from "./labels";

interface GitHubLabel {
  name: string;
}

interface PullRequestInfo {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  title: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  createdAt: string;
  labels: GitHubLabel[];
}

export interface LabelCheck {
  existing: string[];
  missing: string[];
  canCreate: boolean;
}

function parseJson<T>(result: CommandResult, context: string): T {
  if (result.exitCode !== 0) {
    const details = result.stderr.trim() || result.stdout.trim() || "unknown error";
    throw new Error(`${context}: ${details}`);
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(`${context}: GitHub CLI returned invalid JSON.`);
  }
}

export class GitHubClient {
  private readonly repoArg: string;

  constructor(private readonly config: WorkerConfig) {
    this.repoArg = `${config.owner}/${config.repo}`;
  }

  private gh(args: string[]): Promise<CommandResult> {
    return runCommand("gh", args, { cwd: this.config.repoPath });
  }

  async authStatus(): Promise<void> {
    const result = await this.gh(["auth", "status"]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "GitHub CLI is not authenticated.");
    }
  }

  async listIssuesByLabel(label: string): Promise<GitHubIssue[]> {
    return parseJson<GitHubIssue[]>(
      await this.gh([
        "issue",
        "list",
        "--repo",
        this.repoArg,
        "--state",
        "open",
        "--label",
        label,
        "--limit",
        "100",
        "--json",
        "number,title,body,url,createdAt,labels",
      ]),
      `Could not list issues labeled "${label}"`,
    );
  }

  async findNextIssue(): Promise<GitHubIssue | undefined> {
    const issues = await this.listIssuesByLabel(this.config.labels.ready);

    // A failed run always strips the ready label, so ready alongside blocked
    // or human-review can only mean a human re-added it to request a retry.
    // Only active states make an issue ineligible.
    const ignored = new Set([
      this.config.labels.inProgress,
      this.config.labels.prOpened,
    ]);
    return issues
      .filter((issue) => !issue.labels.some((label) => ignored.has(label.name)))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
  }

  async countCommentsContaining(
    issueNumber: number,
    marker: string,
  ): Promise<number> {
    const issue = parseJson<{ comments: Array<{ body: string }> }>(
      await this.gh([
        "issue",
        "view",
        String(issueNumber),
        "--repo",
        this.repoArg,
        "--json",
        "comments",
      ]),
      `Could not read comments on issue #${issueNumber}`,
    );
    return issue.comments.filter((comment) => comment.body.includes(marker)).length;
  }

  async findPullRequestByBranch(branch: string): Promise<PullRequestInfo | undefined> {
    const pulls = parseJson<PullRequestInfo[]>(
      await this.gh([
        "pr",
        "list",
        "--repo",
        this.repoArg,
        "--state",
        "all",
        "--head",
        branch,
        "--limit",
        "10",
        "--json",
        "number,url,state,isDraft,title",
      ]),
      `Could not check pull requests for ${branch}`,
    );
    return pulls[0];
  }

  async updateIssueLabels(
    issueNumber: number,
    add: string[],
    remove: string[],
  ): Promise<void> {
    const args = ["issue", "edit", String(issueNumber), "--repo", this.repoArg];
    for (const label of add) {
      args.push("--add-label", label);
    }
    for (const label of remove) {
      args.push("--remove-label", label);
    }
    const result = await this.gh(args);
    if (result.exitCode !== 0) {
      throw new Error(
        `Could not update labels on issue #${issueNumber}: ${
          result.stderr.trim() || result.stdout.trim()
        }`,
      );
    }
  }

  async setIssueState(
    issueNumber: number,
    states: string[],
  ): Promise<void> {
    const allStates = issueStateLabels(this.config);
    await this.updateIssueLabels(
      issueNumber,
      states,
      allStates.filter((label) => !states.includes(label)),
    );
  }

  async commentOnIssue(issueNumber: number, body: string): Promise<void> {
    const result = await this.gh([
      "issue",
      "comment",
      String(issueNumber),
      "--repo",
      this.repoArg,
      "--body",
      body,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(
        `Could not comment on issue #${issueNumber}: ${
          result.stderr.trim() || result.stdout.trim()
        }`,
      );
    }
  }

  async openPullRequest(input: {
    branch: string;
    title: string;
    body: string;
    draft: boolean;
  }): Promise<string> {
    const args = [
      "pr",
      "create",
      "--repo",
      this.repoArg,
      "--base",
      this.config.baseBranch,
      "--head",
      input.branch,
      "--title",
      input.title,
      "--body",
      input.body,
    ];
    if (input.draft) {
      args.push("--draft");
    }
    const result = await this.gh(args);
    if (result.exitCode !== 0) {
      throw new Error(
        `Could not open pull request: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    return result.stdout.trim();
  }

  async addLabelsToPullRequest(pr: string, labels: string[]): Promise<void> {
    const args = ["pr", "edit", pr, "--repo", this.repoArg];
    for (const label of labels) {
      args.push("--add-label", label);
    }
    const result = await this.gh(args);
    if (result.exitCode !== 0) {
      throw new Error(
        `Could not label pull request ${pr}: ${
          result.stderr.trim() || result.stdout.trim()
        }`,
      );
    }
  }

  async checkLabels(): Promise<LabelCheck> {
    const labels = parseJson<GitHubLabel[]>(
      await this.gh([
        "label",
        "list",
        "--repo",
        this.repoArg,
        "--limit",
        "1000",
        "--json",
        "name",
      ]),
      "Could not list repository labels",
    );
    const existing = labels.map((label) => label.name);
    const required = getLabelDefinitions(this.config).map((label) => label.name);
    const missing = required.filter((label) => !existing.includes(label));

    let canCreate = missing.length === 0;
    if (missing.length > 0) {
      const permissionResult = await this.gh([
        "api",
        `repos/${this.repoArg}`,
        "--jq",
        "(.permissions.push or .permissions.maintain or .permissions.admin)",
      ]);
      canCreate =
        permissionResult.exitCode === 0 && permissionResult.stdout.trim() === "true";
    }
    return { existing, missing, canCreate };
  }

  async ensureLabels(): Promise<string[]> {
    const check = await this.checkLabels();
    const created: string[] = [];
    for (const definition of getLabelDefinitions(this.config)) {
      if (!check.missing.includes(definition.name)) {
        continue;
      }
      const result = await this.gh([
        "label",
        "create",
        definition.name,
        "--repo",
        this.repoArg,
        "--color",
        definition.color,
        "--description",
        definition.description,
      ]);
      if (result.exitCode !== 0) {
        throw new Error(
          `Could not create label "${definition.name}": ${
            result.stderr.trim() || result.stdout.trim()
          }`,
        );
      }
      created.push(definition.name);
    }
    return created;
  }
}
