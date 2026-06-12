# Target Repository Setup Runbook

Use this runbook when a user asks Claude Code or Codex to configure Agent
Nightshift for a specific GitHub repository.

Execute the safe, discoverable steps yourself. Ask the user only for information
that cannot be determined from the workspace or GitHub. Never guess a repository
identity, overwrite existing agent instructions, auto-merge, or enable scheduling
before verification succeeds.

## Required Input

Obtain the target repository as one of:

- `OWNER/REPO`
- A GitHub repository URL
- An existing local checkout with an `origin` remote

If none is available, ask the user for the repository URL or `OWNER/REPO`.

## Non-Negotiable Safety Checks

- Keep the worker checkout and target checkout in separate directories.
- Use a dedicated target clone, not the user's active development checkout.
- Never set `repoPath` to the Agent Nightshift repository itself.
- Refuse to proceed if the dedicated target clone has uncommitted changes.
- Preserve existing `CLAUDE.md` and `AGENTS.md` files.
- Never put secrets, tokens, or credentials in `config.json`.
- Never enable dangerous permission-bypass flags.
- Never auto-merge.
- Require explicit user approval before modifying cron or macOS power schedules.

## 1. Inspect The Worker

From the Agent Nightshift root:

```bash
git status --short --branch
npm install
npm run build
gh auth status
```

Confirm the worker checkout is clean. Determine the absolute paths of the
installed agents:

```bash
command -v claude
command -v codex
```

Use an absolute `agentCommand` path so cron can find the executable.

## 2. Resolve The Target Repository

For `OWNER/REPO`, inspect its metadata:

```bash
gh repo view OWNER/REPO \
  --json nameWithOwner,url,defaultBranchRef
```

Use `defaultBranchRef.name` unless the user explicitly requests another base
branch.

If starting from an existing checkout, verify its remote:

```bash
git -C /absolute/path/to/checkout remote get-url origin
git -C /absolute/path/to/checkout status --short --branch
```

Do not repurpose a checkout with unrelated changes.

## 3. Create A Dedicated Clone

Use this default location unless the user specifies another:

```text
~/Documents/agent-nightshift-targets/<repo-name>
```

Create it:

```bash
mkdir -p ~/Documents/agent-nightshift-targets
gh repo clone OWNER/REPO \
  ~/Documents/agent-nightshift-targets/<repo-name>
```

Verify:

```bash
git -C ~/Documents/agent-nightshift-targets/<repo-name> status --short --branch
git -C ~/Documents/agent-nightshift-targets/<repo-name> remote -v
```

The working tree must be clean and `origin` must match `OWNER/REPO`.

## 4. Inspect Repository-Specific Agent Rules

Read any existing:

- `CLAUDE.md`
- `AGENTS.md`
- Contributing guide
- Test documentation
- CI workflow files

Do not replace existing instructions. If neither `CLAUDE.md` nor `AGENTS.md`
exists, propose a focused setup PR containing rules such as:

```md
# Agent Rules

- Make small, focused changes.
- One issue equals one pull request.
- Never auto-merge.
- Do not modify unrelated files.
- Never touch .env files, secrets, auth, billing, deployment, infrastructure,
  permissions, or database migrations unless explicitly requested.
- Prefer focused tests over broad refactors.
- If uncertain or unsafe, stop and explain.
```

Create that rules file on a separate branch and PR. Do not leave the dedicated
clone dirty. If the rules PR requires manual merging, report that dependency
and continue setup only after the target clone can return to a clean base
branch.

## 5. Discover Validation Commands

Use commands already established by the target repository. Inspect:

- `package.json` scripts
- CI workflows
- `Makefile`
- Language-specific project files
- Repository documentation

For a Node.js repository:

```bash
cd /absolute/path/to/target
npm run
```

Prefer existing commands such as:

```json
"validationCommands": [
  "npm run lint",
  "npm run typecheck",
  "npm test"
]
```

Include only commands that are appropriate for the repository. Missing scripts
are skipped by the worker, but accurate validation is safer. Do not invent a
deployment, migration, destructive, or production command.

## 6. Configure The Worker

Edit the worker's ignored `config.json`. Preserve unrelated settings and set:

```json
{
  "repoPath": "/absolute/path/to/dedicated-target-clone",
  "owner": "OWNER",
  "repo": "REPO",
  "baseBranch": "main",
  "agent": "claude",
  "agentCommand": "/absolute/path/to/claude",
  "agentArgs": ["--permission-mode", "acceptEdits"],
  "maxUsageLimitRetries": 5,
  "staleInProgressMinutes": 150
}
```

Set `validationCommands` from the previous step. Keep or strengthen
`protectedPathPatterns`, including protections for:

```json
[
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "**/*secret*",
  "**/*credential*",
  "**/deploy/**",
  "**/infra/**",
  "**/terraform/**",
  "**/auth/**",
  "**/billing/**",
  "**/migrations/**",
  "**/permissions/**"
]
```

Confirm `config.json` remains ignored:

```bash
git check-ignore -v config.json
```

## 7. Install Labels And Verify

From the worker root:

```bash
npm run build
node dist/index.js install-labels
node dist/index.js doctor
node dist/index.js dry-run
```

Do not continue until `doctor` passes. `dry-run` may legitimately report that
there are no `claude-ready` issues.

## 8. Optional End-To-End Test

Ask the user before creating a test issue or temporarily widening the night
window.

For a daytime test:

1. Create or choose a small, low-risk issue.
2. Add `claude-ready`.
3. Temporarily set `nightWindow` to `0` through `23`.
4. Run `node dist/index.js run`.
5. Restore `nightWindow` to `0` through `6`, even if the run fails.
6. Verify the issue labels, branch, validation output, and opened PR.
7. Confirm the dedicated clone returned to its original branch and is clean.

Never use an auth, billing, secrets, deployment, permissions, infrastructure,
or migration issue as the first test.

## 9. Install Scheduling Only After Approval

Before scheduling, verify again:

- `repoPath` is the dedicated target clone.
- `repoPath` is not the worker root.
- `doctor` passes.
- The target clone is clean.
- The user explicitly approves installing cron.

Then run:

```bash
scripts/install-cron.sh
crontab -l
```

On macOS, cron does not run while the machine sleeps. Explain that a scheduled
wake requires elevated privileges and explicit approval:

```bash
sudo pmset repeat wakeorpoweron MTWRFSU 00:04:00
pmset -g sched
```

Do not enter, request, store, or expose the user's password. Also warn that
`pmset repeat` may replace an existing repeating power schedule; inspect
`pmset -g sched` first.

## 10. Final Report

Report:

- Worker path
- Dedicated target clone path
- GitHub repository and base branch
- Selected agent and command
- Validation commands
- Protected path additions
- Label installation result
- `doctor` and `dry-run` results
- Whether cron was installed
- Whether a macOS wake schedule was configured
- Any manual action still required

Do not claim scheduling is active unless both the cron entry and required wake
behavior were verified.
