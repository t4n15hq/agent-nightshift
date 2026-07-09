---
name: nightshift
description: >
  Set up and manage Agent Nightshift's safe local overnight GitHub issue worker
  using Codex CLI. It selects at most one human-approved issue, validates the
  change, opens a pull request, and never merges.
---

# Agent Nightshift for Codex

Use this skill when the user asks Codex to set up, check, retune, pause, or
operate Agent Nightshift for a GitHub repository.

This skill configures **local mode** only. It drives the local Codex CLI through
the TypeScript worker. It cannot create or manage Claude Code on the web
Routines; those are Claude-specific cloud mode and are described in
`.claude/skills/nightshift/`.

## Setup

1. Read `AGENTS.md`, `CLAUDE.md`, and
   `docs/TARGET_REPOSITORY_SETUP.md`.
2. Identify the target repository from an `OWNER/REPO`, URL, or clean local
   checkout. Never guess it.
3. Keep the worker and target in separate clean checkouts. Never configure the
   worker to operate on its own checkout.
4. Find Codex with `command -v codex`. Use the absolute path in
   `agentCommand`.
5. Configure the worker with:

   ```json
   {
     "agent": "codex",
     "agentCommand": "/absolute/path/to/codex",
     "agentArgs": []
   }
   ```

   The worker invokes Codex as
   `codex exec --sandbox workspace-write <agentArgs> "<prompt>"`.
   Do not add `--dangerously-bypass-approvals-and-sandbox`,
   `--full-auto`, or another permission-bypass flag.
6. Discover only the target repository's established validation commands.
   Never configure deployment, migration, destructive, or production commands.
7. Build, install labels, and run:

   ```bash
   npm run build
   node dist/index.js install-labels
   node dist/index.js doctor
   node dist/index.js dry-run
   ```

8. Do not install cron or change macOS wake settings until the target clone is
   dedicated and clean, `doctor` and `dry-run` pass, and the user gives
   explicit approval.

## Safety

- One issue equals one branch and one pull request.
- Never work directly on the target base branch.
- Never auto-merge.
- Preserve existing `AGENTS.md` and `CLAUDE.md`.
- Never touch protected paths, secrets, auth, billing, deployment,
  infrastructure, permissions, or migrations unless the user explicitly
  changes the worker configuration after review.
- Do not put credentials in `config.json`.
- If the target is ambiguous, unsafe, or has uncommitted changes, stop and
  explain.

## Management

For an already configured local worker:

- Check: `node dist/index.js doctor`
- Preview: `node dist/index.js dry-run`
- Run once: `node dist/index.js run`
- Change worker behavior by editing its ignored `config.json`
- Install or change scheduling only with explicit user approval

Report the target path, agent command, validation commands, protection settings,
and whether cron or wake scheduling is active.