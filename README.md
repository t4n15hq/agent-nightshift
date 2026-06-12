# Claude Night Worker

Claude Night Worker is a local TypeScript automation that takes one GitHub issue
at a time, asks Claude Code or Codex to implement it, validates the change, and
opens a pull request for human review. It never merges pull requests.

## Safety Model

- Runs only during the configured local-time window.
- Processes at most one `claude-ready` issue per invocation.
- Refuses to start if the target repository has uncommitted changes.
- Creates a dedicated `claude/issue-<number>-<slug>` branch from the configured
  base branch before starting the agent.
- Never uses permission-bypass flags and never auto-merges.
- Snapshots protected files, including ignored files such as `.env`, and
  restores them if the agent touches them.
- Blocks protected paths and oversized diffs before commit, then checks again
  after validation.
- Opens a draft PR when validation fails only if explicitly configured.
- Restores rate-limited work to `claude-ready` and exits successfully so cron
  can retry later.
- Refuses to create a second PR when the deterministic issue branch already has
  a PR.

This is a local automation, not a security boundary. Run it in a dedicated,
clean clone and do not edit that clone while the worker is active.

## Requirements

- Node.js 20 or newer
- Git
- [GitHub CLI](https://cli.github.com/)
- Claude Code or Codex CLI
- Push access to the target GitHub repository

## Install

```bash
npm install
npm run build
cp config.example.json config.json
```

Edit `config.json`. At minimum, set `repoPath`, `owner`, `repo`, `baseBranch`,
`agent`, and `agentCommand`. `config.json` is ignored by git.

For cron reliability, an absolute agent path is recommended:

```bash
command -v claude
command -v codex
```

Use the returned path as `agentCommand`. Optional `agentTimeoutMinutes` and
`validationTimeoutMinutes` fields default to 120 and 30.

## Authentication

Authenticate GitHub CLI:

```bash
gh auth login
gh auth status
```

Authenticate the selected coding agent before installing cron. For Claude Code,
run `claude` interactively and complete its login flow. For Codex, run:

```bash
codex login
```

The worker uses `claude -p "<prompt>"` for Claude Code and
`codex exec --sandbox workspace-write "<prompt>"` for Codex. It does not enable
dangerous permission bypass modes.

## Configure

`config.example.json` contains all required fields. Validation commands run in
order. A missing executable or missing package script is skipped with a warning;
the first actual validation failure stops the sequence.

Protected paths use minimatch glob syntax. Removing a protection is an explicit
safety decision. Keep protections for secrets, credentials, auth, billing,
deployment, permissions, migrations, and infrastructure unless a reviewed issue
specifically requires that area.

The configured night window uses the machine's local timezone. A window of
`0` through `6` permits runs from 12:00 AM through 6:59 AM.

## Labels

Create the configured labels and the `agent-pr` label:

```bash
npm run build
node dist/index.js install-labels
```

You can also run `scripts/install-labels.sh`. During the day, add
`claude-ready` to issues you want considered. The worker chooses the oldest
eligible open issue and ignores issues carrying any terminal or active worker
label.

## Check Setup

```bash
node dist/index.js doctor
node dist/index.js dry-run
```

`doctor` checks Git, GitHub CLI, agent availability, authentication, repository
access, base branch access, cleanliness, and labels. `dry-run` prints the next
issue and planned branch without changing labels, branches, files, or PRs.

To use a non-default configuration path:

```bash
node dist/index.js doctor --config /path/to/config.json
```

The `CLAUDE_NIGHT_WORKER_CONFIG` environment variable is also supported.

## Run

```bash
node dist/index.js run
```

The workflow is:

1. Verify the time window and clean repository.
2. Select the oldest eligible `claude-ready` issue.
3. Move it to `claude-in-progress`.
4. Fetch the base branch and create the deterministic issue branch.
5. Run the configured agent with the strict single-issue prompt.
6. Reject protected paths or diffs above `maxDiffLines`.
7. Run validation commands.
8. Commit and push only accepted changes.
9. Open a normal PR on success or an optional draft PR on validation failure.
10. Label the issue and PR for morning review.

Agent errors, unsafe changes, and non-draft validation failures are reported on
the issue as `claude-blocked` or `human-review-required`.

## Install Cron

Build and configure the project first, then run:

```bash
scripts/install-cron.sh
```

It preserves existing cron entries and installs:

```cron
5,35 0-6 * * * cd /path/to/claude-night-worker && node dist/index.js run >> ~/claude-night-worker.log 2>&1
```

The installed line uses absolute local paths and captures the current `PATH` so
cron can locate `gh` and the configured agent. Re-running the script replaces
this worker's prior entry instead of duplicating it.

## Morning Review

1. Open PRs labeled `agent-pr`.
2. Check CI.
3. Review the diff manually.
4. Merge good PRs.
5. Close bad PRs or comment with fixes.
6. Re-label the issue `claude-ready` if you want the agent to retry.

The worker does not auto-merge, approve, or mark a draft PR ready.
