# Agent Rules

- Make small, focused changes.
- Work on exactly one issue per branch and pull request.
- Never work directly on `main` or the configured base branch.
- Never auto-merge.
- Never touch `.env`, secrets, credentials, auth, billing, production deployment, permissions, infrastructure, or database migrations unless explicitly requested and allowed by the worker configuration.
- Do not delete data.
- Prefer focused tests over broad refactors.
- Do not modify unrelated files.
- If the issue is uncertain, unsafe, or impossible, stop and explain why.

## Configuring A Target Repository

Agent Nightshift has two modes; pick based on what the user asks for:

- **Cloud mode** (overnight cloud agents, laptop can be off): follow the
  `/nightshift` skill in `.claude/skills/nightshift/SKILL.md`. It must run in
  a Claude Code on the web session on the target repository; from this repo,
  offer to open a PR copying the skill directory into the target.
- **Local mode** (cron + local CLI worker): when the user asks to set up the
  local worker for a specific repository, read and execute
  `docs/TARGET_REPOSITORY_SETUP.md`.

Use a dedicated clean clone for the target. Never configure the worker to
operate on this repository's own checkout. Do not install cron or change
macOS wake schedules until the target configuration passes `doctor` and
`dry-run`, and the user has explicitly approved scheduling.
