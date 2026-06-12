#!/usr/bin/env node

import { open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { runAgent } from "./agent";
import {
  isInsideNightWindow,
  loadConfig,
  pathExists,
  type WorkerConfig,
} from "./config";
import {
  GitClient,
  matchesProtectedPath,
  runCommand,
  slugifyTitle,
  type ProtectedSnapshot,
} from "./git";
import { GitHubClient, type GitHubIssue } from "./github";
import { formatError, logger, truncate } from "./logger";
import { buildPrompt } from "./prompt";
import {
  formatValidationSummary,
  runValidation,
  validationPassed,
  type ValidationResult,
} from "./validator";

type Command = "run" | "dry-run" | "doctor" | "install-labels";

interface CliArgs {
  command: Command;
  configPath?: string;
}

interface Lock {
  release(): Promise<void>;
}

function usage(): string {
  return `Usage: node dist/index.js <run|dry-run|doctor|install-labels> [--config path]`;
}

function parseArgs(argv: string[]): CliArgs {
  const command = argv[0] as Command | undefined;
  if (!command || !["run", "dry-run", "doctor", "install-labels"].includes(command)) {
    throw new Error(usage());
  }
  const configIndex = argv.indexOf("--config");
  const configPath = configIndex >= 0 ? argv[configIndex + 1] : undefined;
  if (configIndex >= 0 && !configPath) {
    throw new Error("--config requires a path.");
  }
  return { command, configPath };
}

function branchName(issue: GitHubIssue): string {
  return `claude/issue-${issue.number}-${slugifyTitle(issue.title)}`;
}

function protectedFiles(config: WorkerConfig, files: string[]): string[] {
  return files.filter((file) =>
    matchesProtectedPath(file, config.protectedPathPatterns),
  );
}

function makePullRequestBody(
  issue: GitHubIssue,
  agentSummary: string,
  validation: ValidationResult[],
  draft: boolean,
): string {
  return `Closes #${issue.number}

Automated overnight agent pass.

## Summary
${truncate(agentSummary) || "The agent did not provide a summary."}

## Validation
${formatValidationSummary(validation)}

## Safety
- [ ] Human reviewed
- [ ] CI passed
- [ ] No protected files changed
- [ ] No auth/billing/deployment/secrets touched

## Notes
${
  draft
    ? "This is a draft because one or more validation commands failed. Review the validation output before making it ready."
    : "Human review is required before merge. This worker never auto-merges."
}
`;
}

async function acquireLock(repoPath: string): Promise<Lock> {
  const gitDirectory = (
    await runCommand("git", ["rev-parse", "--git-dir"], { cwd: repoPath })
  ).stdout.trim();
  if (!gitDirectory) {
    throw new Error("Could not locate the repository git directory.");
  }
  const lockPath = path.resolve(repoPath, gitDirectory, "claude-night-worker.lock");
  async function createLock(): Promise<void> {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
    await handle.close();
  }

  try {
    await createLock();
  } catch (error) {
    const fileError = error as NodeJS.ErrnoException;
    if (fileError.code !== "EEXIST") {
      throw error;
    }
    let details = "";
    try {
      details = (await readFile(lockPath, "utf8")).trim();
    } catch {
      // The lock may have disappeared between open and read.
    }
    const pid = Number(details.split("\n")[0]);
    let processIsRunning = Number.isInteger(pid) && pid > 0;
    if (processIsRunning) {
      try {
        process.kill(pid, 0);
      } catch (processError) {
        processIsRunning = (processError as NodeJS.ErrnoException).code === "EPERM";
      }
    }
    if (!processIsRunning) {
      await rm(lockPath, { force: true });
      await createLock();
    } else {
      throw new Error(
        `Another night worker appears to be running (${lockPath}${
          details ? `: ${details.replaceAll("\n", ", ")}` : ""
        }).`,
      );
    }
  }
  return {
    async release(): Promise<void> {
      await rm(lockPath, { force: true });
    },
  };
}

async function commandExists(command: string): Promise<boolean> {
  try {
    const result = await runCommand(command, ["--version"]);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

async function doctor(config: WorkerConfig): Promise<number> {
  const checks: Array<{ name: string; run: () => Promise<string> }> = [
    {
      name: "git installed",
      run: async () => {
        if (!(await commandExists("git"))) {
          throw new Error("git --version failed");
        }
        return "available";
      },
    },
    {
      name: "GitHub CLI installed",
      run: async () => {
        if (!(await commandExists("gh"))) {
          throw new Error("gh --version failed");
        }
        return "available";
      },
    },
    {
      name: `${config.agent} agent installed`,
      run: async () => {
        if (!(await commandExists(config.agentCommand))) {
          throw new Error(`${config.agentCommand} --version failed`);
        }
        return config.agentCommand;
      },
    },
    {
      name: "repository path",
      run: async () => {
        if (!(await pathExists(config.repoPath))) {
          throw new Error(`${config.repoPath} does not exist`);
        }
        await new GitClient(config.repoPath).assertRepository();
        return config.repoPath;
      },
    },
    {
      name: "GitHub authentication",
      run: async () => {
        await new GitHubClient(config).authStatus();
        return "authenticated";
      },
    },
    {
      name: `base branch ${config.baseBranch}`,
      run: async () => {
        const git = new GitClient(config.repoPath);
        if (!(await git.canAccessBase(config.baseBranch))) {
          throw new Error(`HEAD cannot access ${config.baseBranch}`);
        }
        return "accessible";
      },
    },
    {
      name: "working tree",
      run: async () => {
        if (!(await new GitClient(config.repoPath).isClean())) {
          throw new Error("repository has uncommitted changes");
        }
        return "clean";
      },
    },
    {
      name: "worker labels",
      run: async () => {
        const check = await new GitHubClient(config).checkLabels();
        if (check.missing.length > 0 && !check.canCreate) {
          throw new Error(`missing and cannot create: ${check.missing.join(", ")}`);
        }
        return check.missing.length
          ? `can create missing labels: ${check.missing.join(", ")}`
          : "all labels exist";
      },
    },
  ];

  let failures = 0;
  for (const check of checks) {
    try {
      logger.info(`PASS ${check.name}: ${await check.run()}`);
    } catch (error) {
      failures += 1;
      logger.error(`FAIL ${check.name}: ${formatError(error)}`);
    }
  }
  logger.info(
    failures === 0
      ? "Doctor completed successfully."
      : `Doctor found ${failures} problem(s).`,
  );
  return failures === 0 ? 0 : 1;
}

async function dryRun(config: WorkerConfig): Promise<number> {
  const git = new GitClient(config.repoPath);
  await git.assertRepository();
  if (!(await git.isClean())) {
    throw new Error("Refusing dry-run because the repository has uncommitted changes.");
  }
  const issue = await new GitHubClient(config).findNextIssue();
  if (!issue) {
    logger.info(`No open issues are labeled "${config.labels.ready}".`);
    return 0;
  }
  logger.info(`Dry run selected the oldest eligible issue: #${issue.number} ${issue.title}`);
  console.log(`Issue: ${issue.url}`);
  console.log(`Branch: ${branchName(issue)}`);
  console.log(`Base: ${config.baseBranch}`);
  console.log(`Agent: ${config.agentCommand}`);
  console.log(`Validation: ${config.validationCommands.join(" -> ") || "(none)"}`);
  console.log("No labels, branches, files, or pull requests were changed.");
  return 0;
}

async function cleanupBranch(
  git: GitClient,
  originalBranch: string,
  workerBranch: string,
  config: WorkerConfig,
  protectedSnapshot?: ProtectedSnapshot,
): Promise<void> {
  if (!(await git.isClean())) {
    await git.discardChanges();
  }
  if (protectedSnapshot) {
    await git.restoreProtectedFiles(
      protectedSnapshot,
      config.protectedPathPatterns,
    );
  }
  if ((await git.currentBranch()) !== originalBranch) {
    // Force: if the agent committed protected-file changes, the restore above
    // leaves the tree dirty against that commit; the branch is deleted anyway.
    await git.switchBranch(originalBranch, { force: true });
  }
  await git.deleteLocalBranch(workerBranch);
}

const USAGE_LIMIT_RETRY_MARKER = "<!-- night-worker-usage-limit-retry -->";

// A crash (power loss, forced sleep, SIGKILL) after the in-progress label is
// set leaves the issue invisible to findNextIssue forever. We hold the lock,
// so any in-progress label seen now is stale and safe to reconcile.
async function recoverStaleIssues(
  github: GitHubClient,
  config: WorkerConfig,
): Promise<void> {
  for (const issue of await github.listIssuesByLabel(config.labels.inProgress)) {
    const pr = await github.findPullRequestByBranch(branchName(issue));
    if (pr) {
      const state =
        pr.state.toLowerCase() === "open"
          ? config.labels.prOpened
          : config.labels.humanReview;
      await github.setIssueState(issue.number, [state]);
      await github.commentOnIssue(
        issue.number,
        `Night worker found this issue stuck in "${config.labels.inProgress}" from an interrupted run. PR ${pr.url} exists (${pr.state.toLowerCase()}), so the label was reconciled.`,
      );
    } else {
      await github.setIssueState(issue.number, [config.labels.ready]);
      await github.commentOnIssue(
        issue.number,
        `Night worker found this issue stuck in "${config.labels.inProgress}" from an interrupted run with no pull request. It was returned to "${config.labels.ready}".`,
      );
    }
    logger.warn(`Recovered stale in-progress issue #${issue.number}.`);
  }
}

async function failIssue(
  github: GitHubClient,
  issue: GitHubIssue,
  state: string,
  reason: string,
): Promise<void> {
  await github.setIssueState(issue.number, [state]);
  await github.commentOnIssue(
    issue.number,
    `Night worker stopped without opening a normal pull request.\n\n${truncate(reason, 3_000)}`,
  );
}

async function runWorker(config: WorkerConfig): Promise<number> {
  if (!isInsideNightWindow(config.nightWindow)) {
    logger.info(
      `Outside configured night window (${config.nightWindow.startHour}:00-${config.nightWindow.endHour}:59 local time); exiting.`,
    );
    return 0;
  }

  const git = new GitClient(config.repoPath);
  const github = new GitHubClient(config);
  await git.assertRepository();
  if (!(await git.isClean())) {
    throw new Error("Refusing to run because the repository has uncommitted changes.");
  }

  const lock = await acquireLock(config.repoPath);
  let originalBranch = "";
  let workerBranch = "";
  let protectedSnapshot: ProtectedSnapshot | undefined;
  let issue: GitHubIssue | undefined;
  try {
    await github.authStatus();
    await github.ensureLabels();
    await recoverStaleIssues(github, config);
    issue = await github.findNextIssue();
    if (!issue) {
      logger.info(`No open issues are labeled "${config.labels.ready}".`);
      return 0;
    }

    originalBranch = await git.currentBranch();
    workerBranch = branchName(issue);
    const existingPr = await github.findPullRequestByBranch(workerBranch);
    if (existingPr) {
      const state =
        existingPr.state.toLowerCase() === "open"
          ? config.labels.prOpened
          : config.labels.humanReview;
      await failIssue(
        github,
        issue,
        state,
        `Branch \`${workerBranch}\` already has ${existingPr.state.toLowerCase()} PR ${existingPr.url}. The worker will not create a second PR for the issue.`,
      );
      return existingPr.state.toLowerCase() === "open" ? 0 : 1;
    }

    await git.fetchBase(config.baseBranch);
    if (await git.branchExists(workerBranch)) {
      await failIssue(
        github,
        issue,
        config.labels.humanReview,
        `Branch \`${workerBranch}\` already exists without a discoverable pull request. Remove or reconcile it manually before retrying.`,
      );
      return 1;
    }

    await github.setIssueState(issue.number, [config.labels.inProgress]);
    const baseRef = await git.resolveBaseRef(config.baseBranch);
    await git.createBranch(workerBranch, baseRef);
    const baseSha = await git.headSha();
    protectedSnapshot = await git.snapshotProtectedFiles(
      config.protectedPathPatterns,
    );
    logger.info(`Working on issue #${issue.number} in ${workerBranch}.`);

    const agent = await runAgent(config, buildPrompt(issue));
    if (agent.usageLimited) {
      await cleanupBranch(
        git,
        originalBranch,
        workerBranch,
        config,
        protectedSnapshot,
      );
      const previousRetries = await github.countCommentsContaining(
        issue.number,
        USAGE_LIMIT_RETRY_MARKER,
      );
      if (previousRetries >= config.maxUsageLimitRetries) {
        await failIssue(
          github,
          issue,
          config.labels.blocked,
          `The agent reported a usage or rate limit ${
            previousRetries + 1
          } times for this issue, reaching the configured maximum of ${
            config.maxUsageLimitRetries
          } retries. A real failure may be misclassified as a limit; check the worker log.`,
        );
        return 1;
      }
      logger.warn("Agent usage or rate limit detected; restoring issue to ready.");
      await github.commentOnIssue(
        issue.number,
        `Night worker paused: the agent reported a usage or rate limit. Returned to "${
          config.labels.ready
        }" for retry ${previousRetries + 1} of ${
          config.maxUsageLimitRetries
        }.\n\n${USAGE_LIMIT_RETRY_MARKER}`,
      );
      await github.setIssueState(issue.number, [config.labels.ready]);
      return 0;
    }
    if (agent.timedOut || agent.exitCode !== 0) {
      const reason = agent.timedOut
        ? "The agent timed out."
        : `The agent exited with code ${agent.exitCode}.\n\n${truncate(
            agent.stderr || agent.stdout,
            2_500,
          )}`;
      await cleanupBranch(
        git,
        originalBranch,
        workerBranch,
        config,
        protectedSnapshot,
      );
      await failIssue(github, issue, config.labels.blocked, reason);
      return 1;
    }

    let changed = await git.changedFiles(baseSha);
    let protectedChanged = [
      ...new Set([
        ...protectedFiles(config, changed),
        ...(await git.changedProtectedFiles(
          protectedSnapshot,
          config.protectedPathPatterns,
        )),
      ]),
    ].sort();
    if (protectedChanged.length > 0) {
      const reason = `Protected paths were changed:\n${protectedChanged
        .map((file) => `- \`${file}\``)
        .join("\n")}`;
      await cleanupBranch(
        git,
        originalBranch,
        workerBranch,
        config,
        protectedSnapshot,
      );
      await failIssue(github, issue, config.labels.humanReview, reason);
      return 1;
    }

    if (changed.length === 0) {
      await cleanupBranch(
        git,
        originalBranch,
        workerBranch,
        config,
        protectedSnapshot,
      );
      await failIssue(
        github,
        issue,
        config.labels.blocked,
        "The agent completed without making any file changes.",
      );
      return 1;
    }

    let diffLines = await git.diffLineCount(baseSha);
    if (diffLines > config.maxDiffLines) {
      await cleanupBranch(
        git,
        originalBranch,
        workerBranch,
        config,
        protectedSnapshot,
      );
      await failIssue(
        github,
        issue,
        config.labels.humanReview,
        `The proposed change was ${diffLines.toLocaleString()} lines, above the configured limit of ${config.maxDiffLines.toLocaleString()}. Changes were reverted.`,
      );
      return 1;
    }

    const validation = await runValidation(config);
    changed = await git.changedFiles(baseSha);
    protectedChanged = [
      ...new Set([
        ...protectedFiles(config, changed),
        ...(await git.changedProtectedFiles(
          protectedSnapshot,
          config.protectedPathPatterns,
        )),
      ]),
    ].sort();
    diffLines = await git.diffLineCount(baseSha);
    if (protectedChanged.length > 0 || diffLines > config.maxDiffLines) {
      const reason =
        protectedChanged.length > 0
          ? `Validation or the agent changed protected paths:\n${protectedChanged
              .map((file) => `- \`${file}\``)
              .join("\n")}`
          : `The final change was ${diffLines.toLocaleString()} lines, above the configured limit of ${config.maxDiffLines.toLocaleString()}.`;
      await cleanupBranch(
        git,
        originalBranch,
        workerBranch,
        config,
        protectedSnapshot,
      );
      await failIssue(github, issue, config.labels.humanReview, reason);
      return 1;
    }

    const passed = validationPassed(validation);
    if (!passed && !config.openDraftPrOnValidationFailure) {
      await cleanupBranch(
        git,
        originalBranch,
        workerBranch,
        config,
        protectedSnapshot,
      );
      await failIssue(
        github,
        issue,
        config.labels.blocked,
        `Validation failed and draft pull requests are disabled.\n\n${formatValidationSummary(
          validation,
        )}`,
      );
      return 1;
    }

    const commitTitle = `Fix issue #${issue.number}: ${issue.title}`;
    await git.commitAll(commitTitle, baseSha);
    await git.push(workerBranch);
    const prUrl = await github.openPullRequest({
      branch: workerBranch,
      title: `Fix #${issue.number}: ${issue.title}`,
      body: makePullRequestBody(issue, agent.stdout, validation, !passed),
      draft: !passed,
    });
    const prLabels = passed
      ? ["agent-pr"]
      : ["agent-pr", config.labels.humanReview];
    try {
      await github.addLabelsToPullRequest(prUrl, prLabels);
    } catch (error) {
      logger.warn(formatError(error));
    }
    await github.setIssueState(
      issue.number,
      passed
        ? [config.labels.prOpened]
        : [config.labels.prOpened, config.labels.humanReview],
    );
    if (!passed) {
      await github.commentOnIssue(
        issue.number,
        `The worker opened draft PR ${prUrl} because validation failed. Human review is required.`,
      );
    }
    await git.switchBranch(originalBranch);
    await git.deleteLocalBranch(workerBranch);
    logger.info(`${passed ? "Opened" : "Opened draft"} pull request: ${prUrl}`);
    return 0;
  } catch (error) {
    const reason = formatError(error);
    logger.error(reason);
    if (workerBranch && originalBranch) {
      try {
        await cleanupBranch(
          git,
          originalBranch,
          workerBranch,
          config,
          protectedSnapshot,
        );
      } catch (cleanupError) {
        logger.error(`Cleanup failed: ${formatError(cleanupError)}`);
      }
    }
    if (issue) {
      try {
        await failIssue(github, issue, config.labels.blocked, reason);
      } catch (reportError) {
        logger.error(`Could not report failure on issue: ${formatError(reportError)}`);
      }
    }
    return 1;
  } finally {
    await lock.release();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { config, configPath } = await loadConfig(args.configPath);
  logger.info(`Using configuration ${configPath}.`);

  let exitCode = 0;
  if (args.command === "doctor") {
    exitCode = await doctor(config);
  } else if (args.command === "dry-run") {
    exitCode = await dryRun(config);
  } else if (args.command === "install-labels") {
    const created = await new GitHubClient(config).ensureLabels();
    logger.info(
      created.length > 0
        ? `Created labels: ${created.join(", ")}.`
        : "All required labels already exist.",
    );
  } else {
    exitCode = await runWorker(config);
  }
  process.exitCode = exitCode;
}

main().catch((error) => {
  logger.error(formatError(error));
  process.exitCode = 1;
});
