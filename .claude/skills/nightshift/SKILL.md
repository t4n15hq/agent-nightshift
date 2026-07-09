---
name: nightshift
description: >
  Set up overnight autonomous GitHub issue-fixing using scheduled cloud agents.
  Creates a nightly Routine of fresh Claude Code on the web sessions that each
  pick up one claude-ready issue, implement it, validate it, and open a pull
  request for human review — using subscription capacity that would otherwise
  sit idle overnight, with no laptop required. Use when the user asks for
  overnight automation, a nightshift, using overnight limits, or scheduled
  background issue fixing.
---

# Nightshift: overnight cloud agents

You are setting up (or managing) an overnight automation for the repository
this session is working on. Each night, on a schedule, a **fresh cloud
session** wakes up, picks **at most one** GitHub issue labeled ready, fixes
it on a dedicated branch, validates, and opens a PR. It never merges.

The point of running at night: subscription usage limits refresh on rolling
windows, so capacity that would expire unused while the user sleeps gets spent
on their backlog instead. Because the sessions run in the cloud, the user's
machine can be off.

## Where this skill must run

Nightly sessions are spawned in **this session's environment**, so this skill
must be invoked from a **Claude Code on the web session whose repository is
the target repository** (the repo the issues live in).

Check for the scheduling tool first: use ToolSearch for
`claude-code-remote create_trigger`. Then:

- **Tool available** → proceed with setup below.
- **Tool unavailable** (local CLI, no remote scheduling): stop and tell the
  user to open https://claude.ai/code, start a session on the target
  repository, and run `/nightshift` there. Do not try to emulate the schedule
  with local cron from this skill; the local worker in the agent-nightshift
  repo already covers that mode.
- **Wrong repository** (this session is on the agent-nightshift worker repo
  itself, and the user named a different target): offer to open a small setup
  PR to the target repository that copies this skill directory
  (`.claude/skills/nightshift/`) into it, so the user can then run
  `/nightshift` from a web session on that repo. Never schedule nightly runs
  against the agent-nightshift repo itself unless the user explicitly wants
  the automation to work on this repo's own issues.

## Management subcommands

If the user's request is to manage an existing nightshift rather than set one
up, use the claude-code-remote trigger tools directly:

- **status** → `list_triggers`; report the nightshift Routine's schedule,
  enabled state, and next run; list currently ready-labeled issues.
- **pause / resume** → `update_trigger` with `enabled: false` / `true`.
- **run now** → `fire_trigger` (confirm with the user first).
- **uninstall** → `delete_trigger`; ask whether to also remove the labels.

## Setup procedure

### 1. Confirm the target and gather preferences

Identify OWNER/REPO and default branch from the current checkout
(`git remote get-url origin`). Then ask the user (AskUserQuestion, batched):

1. **Night window & timezone** — when should runs fire, and in which local
   timezone? Default: two runs per night at roughly 00:30 and 03:30 local
   time. Convert local times to UTC yourself for the cron expression; state
   the conversion in your summary so the user can catch a mistake.
2. **Runs per night** — each run handles at most one issue, so N runs ≈ N
   issues per night. Default 2. (Routines have a minimum interval of one
   hour; space firings at least an hour apart.)
3. **Draft PR on validation failure?** — if validation fails, open a draft PR
   for triage (default) or mark the issue blocked instead.
4. **Notifications** — push and/or email when a nightly run finishes with
   something noteworthy. Default: push on.

Use these defaults without asking unless the user objects: max diff
**800 changed lines**; labels `claude-ready`, `claude-in-progress`,
`claude-pr-opened`, `claude-blocked`, `human-review-required`; protected
path patterns as listed in `references/nightly-run.md`.

### 2. Discover validation commands

Inspect `package.json` scripts, CI workflows, `Makefile`, and repo docs.
Prefer the repo's established lint/typecheck/test commands. Never include
deployment, migration, destructive, or production commands.

### 3. Install labels

Create the five labels on the target repo if missing (GitHub MCP tools or
`gh label create`). Suggested colors: ready `0E8A16`, in-progress `FBCA04`,
pr-opened `1D76DB`, blocked `B60205`, human-review `5319E7`.

### 4. Doctor checks

Before scheduling, verify and report:

- Push access to the repo and the base branch name (e.g. `get_me` +
  repo metadata, or `gh auth status` / `gh repo view`).
- The labels exist.
- List issues currently labeled ready, so the user sees exactly what the
  first night would pick up. Zero ready issues is fine — say so.
- No existing nightshift Routine already targets this repo
  (`list_triggers`; look for names starting `nightshift:`). If one exists,
  update it instead of creating a duplicate.

### 5. Build the nightly prompt

Read `references/nightly-run.md` from this skill directory and fill in every
`{{PLACEHOLDER}}` with the gathered configuration. The result must be fully
standalone — each nightly session starts with zero context.

### 6. Optional supervised test run

Offer (do not push) a supervised test: after the Routine is created, call
`fire_trigger` once while the user is watching, using a small low-risk issue
they choose. Never use an auth, billing, secrets, deployment, permissions,
infrastructure, or migration issue as the first test.

### 7. Create the Routine — only with explicit approval

Show the user the final cron expression (UTC), the filled prompt, and the
notification settings, and get an explicit yes. Then call
`create_trigger` with:

- `name`: `nightshift: OWNER/REPO`
- `cron_expression`: the UTC schedule (e.g. `30 5,8 * * *` for 00:30 and
  03:30 America/Los_Angeles during PDT — compute for the user's actual zone)
- `create_new_session_on_fire`: `true`
- `prompt`: the filled nightly prompt
- `notifications`: per the user's choice

Warn the user that cron is UTC and does not track daylight-saving changes;
their local firing time will shift by an hour across DST transitions unless
they ask you (or a future session) to adjust it.

### 8. Report

Summarize: repo and base branch, schedule in both local time and UTC, runs
per night, validation commands, labels, diff limit, draft-PR policy,
notifications, trigger ID, and how to manage it later (pause, run now,
uninstall — see Management subcommands). Remind the user that queueing work
is just adding the ready label to an issue, and that nothing is ever merged
without a human.

## Safety rules (non-negotiable)

- Never merge or enable auto-merge; the nightly prompt must forbid it too.
- At most one issue per nightly session.
- Never schedule before the doctor checks pass and the user explicitly
  approves.
- Never put tokens or secrets in the Routine prompt or name.
- Never weaken the protected-path list in `references/nightly-run.md`
  without the user explicitly asking.
- If anything about the target repo makes unattended edits risky (monorepo
  with production config at the root, no tests at all, etc.), say so before
  scheduling instead of silently proceeding.
