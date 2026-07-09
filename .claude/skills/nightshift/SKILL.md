---
name: nightshift
description: >
  One-time setup for overnight autonomous GitHub issue-fixing using scheduled
  cloud agents. Creates a nightly Routine of fresh Claude Code on the web
  sessions that tend yesterday's PRs, pick up one open issue, implement it
  with a strict minimal-diff quality bar, and open a pull request for human
  review — using subscription capacity that would otherwise sit idle
  overnight, with no laptop required. Use when the user asks for overnight
  automation, a nightshift, using overnight limits, or scheduled background
  issue fixing.
---

# Nightshift: set-and-forget overnight cloud agents

You are setting up (or managing) an overnight automation for a GitHub
repository. After a single setup, every night a **fresh cloud session**
wakes on a schedule and runs a pipeline: self-check → steward existing
nightshift PRs (fix CI, address review comments, rebase) → pick **at most
one** new issue → implement it under a strict no-slop quality bar → open a
PR. It never merges. Persistent state lives in a rolling "🌙 Nightshift
log" issue, so no session depends on any other.

The point of running at night: subscription usage limits refresh on rolling
windows, so capacity that would expire unused while the user sleeps gets
spent on their backlog instead. Because the sessions run in the cloud, the
user's machine can be off.

## Where this skill can run

Check for the scheduling tool first: ToolSearch for
`claude-code-remote create_trigger`.

- **Tool unavailable** (local CLI): stop and tell the user to open
  https://claude.ai/code and run `/nightshift` from a session there. Do not
  emulate the schedule with local cron; the local worker in the
  agent-nightshift repo covers that mode.
- **Tool available, session is on the target repo**: proceed; nightly
  sessions will inherit this session's environment automatically.
- **Tool available, user named a different target repo**: this still works
  without copying anything — resolve the target's environment with
  `list_environments` (and `list_repos` to confirm access), and pass its
  `environment_id` to `create_trigger`. If no environment exists for the
  target repo yet, ask the user to open a claude.ai/code session on it once
  (that creates the environment), then finish setup from here. Never
  schedule nightly runs against the agent-nightshift worker repo itself
  unless the user explicitly wants that.

## Management subcommands

If the user wants to manage an existing nightshift rather than set one up:

- **status** → `list_triggers` for the `nightshift: OWNER/REPO` Routine
  (schedule, enabled, next run) + read the last few comments on the
  "🌙 Nightshift log" issue + count of currently eligible issues.
- **pause / resume** → `update_trigger` with `enabled: false` / `true`.
  Note: nightly runs disable the Routine themselves after three consecutive
  systemic failures — if the user asks "why did it stop", check the log
  issue before assuming they paused it.
- **run now** → `fire_trigger` (confirm with the user first).
- **retune** (change schedule, triage mode, diff cap, etc.) → schedule and
  name changes via `update_trigger`; everything else lives in the repo's
  `.claude/nightshift.json`, so change it with an ordinary commit or PR. If
  the repo has no config file yet and the change is to a prompt-baked
  default, recreate the Routine (delete + create) with the new prompt.
- **uninstall** → `delete_trigger`; ask whether to also remove the labels
  and close the log issue.

## Setup procedure

Bias every step toward "one invocation, zero maintenance": prefer defaults,
ask once, and put anything tunable into the repo config file rather than
requiring the user to ever re-run setup.

### 1. Confirm the target and gather preferences

Identify OWNER/REPO and default branch (from the current checkout's
`git remote get-url origin`, or from what the user named). Then ask ONE
batched AskUserQuestion round, with recommended defaults marked:

1. **Night window & timezone** — default two runs per night at roughly
   00:30 and 03:30 local time. Convert to UTC yourself for the cron
   expression and state the conversion in the summary. (Routines have a
   minimum interval of one hour; each run handles at most one new issue.)
2. **Issue selection** — `auto` (recommended: human-labeled `claude-ready`
   issues first; when none, the agent triages the backlog itself and picks
   only clearly safe, small, well-specified issues), `labels-only`
   (opt-in per issue, most conservative), or `opt-out` (every open issue
   eligible unless labeled `nightshift-skip` — only if the user explicitly
   wants full autonomy).
3. **Validation failure policy** — `draft` (recommended: open a draft PR
   for triage) or `block` (no PR, label the issue blocked).
4. **Notifications** — push and/or email on noteworthy runs. Default:
   push on.

Use without asking unless the user objects: max diff **800 changed lines**;
`maxStewardActions` **2**; `usageLimitRetryCap` **3**; labels
`claude-ready`, `claude-in-progress`, `claude-pr-opened`, `claude-blocked`,
`human-review-required`, `nightshift-skip`, `nightshift-log`.

### 2. Discover validation commands

Inspect `package.json` scripts, CI workflows, `Makefile`, and repo docs.
Prefer the repo's established lint/typecheck/test commands. Never include
deployment, migration, destructive, or production commands. (Nightly runs
re-discover commands themselves when the config doesn't pin any, so an
empty list is acceptable for repos with no obvious commands.)

### 3. Install labels and the log issue

Create the labels from step 1 if missing (GitHub MCP tools or `gh label
create`). Suggested colors: ready `0E8A16`, in-progress `FBCA04`,
pr-opened `1D76DB`, blocked `B60205`, human-review `5319E7`, skip
`CFD3D7`, log `0052CC`. Create the "🌙 Nightshift log" issue labeled
`nightshift-log` with a short body explaining that the agent appends one
comment per run and that the issue is the automation's memory and audit
trail.

### 4. Doctor checks

Before scheduling, verify and report: push access and base branch; labels
and log issue exist; the list of issues the first night would consider
(zero is fine — say so); and that no `nightshift: OWNER/REPO` Routine
already exists (`list_triggers` — if one does, update or recreate it
instead of duplicating).

### 5. Build the nightly prompt

Read `references/nightly-run.md` from this skill directory, fill
`{{OWNER}}`/`{{REPO}}`, and fill `{{CONFIG_JSON}}` with the assembled
config object (schema documented in that file). The prompt must be fully
standalone — each nightly session starts with zero context.

Offer (don't require) to also commit `.claude/nightshift.json` with the
same config to the target repo via a small PR: nightly runs merge that file
over the prompt-baked defaults, which makes every future tuning change an
ordinary commit instead of a Routine rebuild.

### 6. Create the Routine — only with explicit approval

Show the user the cron expression (UTC and their local time), the triage
mode, and the notification settings, and get an explicit yes. Then
`create_trigger` with:

- `name`: `nightshift: OWNER/REPO` (exact format — nightly runs find their
  own Routine by this name to self-disable on repeated systemic failure)
- `cron_expression`: the UTC schedule (e.g. `30 5,8 * * *` for 00:30 and
  03:30 America/Los_Angeles during PDT)
- `create_new_session_on_fire`: `true`
- `environment_id`: only when targeting a repo other than this session's
- `prompt`: the filled nightly prompt
- `notifications`: per the user's choice

Warn that cron is UTC and does not track daylight-saving changes; local
firing times shift by an hour across DST transitions unless retuned.

### 7. Optional supervised test run

Offer a supervised first run via `fire_trigger` on a small, low-risk issue
the user chooses. Never use an auth, billing, secrets, deployment,
permissions, infrastructure, or migration issue as the first test.

### 8. Report

Summarize: repo and base branch, schedule (local + UTC), triage mode,
validation commands, labels, diff cap, failure policy, notifications,
trigger ID, whether a repo config PR was opened, and the management
subcommands above. Make the set-and-forget contract explicit: from now on
the only recurring human jobs are reviewing/merging PRs and (optionally)
labeling issues `claude-ready` to prioritize them; everything else —
including tending its own PRs and shutting itself off if broken — the
nightshift does itself, and its history is always on the log issue.

## Safety rules (non-negotiable)

- Never merge or enable auto-merge; the nightly prompt must forbid it too.
- At most one new issue per nightly session.
- Never schedule before the doctor checks pass and the user explicitly
  approves.
- Never put tokens or secrets in the Routine prompt, name, or repo config.
- Never weaken the protected-path list in `references/nightly-run.md`
  without the user explicitly asking.
- `opt-out` triage mode only on explicit user request — the recommended
  default keeps human labels as the primary steering input.
- If anything about the target repo makes unattended edits risky (monorepo
  with production config at the root, no tests at all, etc.), say so before
  scheduling instead of silently proceeding.
