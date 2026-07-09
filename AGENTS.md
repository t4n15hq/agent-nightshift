# Codex Instructions

Follow the safety rules in `CLAUDE.md`.

When the user asks to configure Agent Nightshift for a specific repository with
Codex, read and execute `.codex/skills/nightshift/SKILL.md` and
`docs/TARGET_REPOSITORY_SETUP.md` (local cron worker).

The cloud mode that runs while the laptop is off is Claude Code on the web
only; see `.claude/skills/nightshift/SKILL.md` and
`docs/CLOUD_NIGHTSHIFT.md`. Do not claim that Codex can create or manage a
Claude cloud Routine.

Do not install cron or change macOS wake schedules until:

- The target repository is known.
- The worker uses a separate, dedicated clone.
- `config.json` no longer points at this worker repository.
- `doctor` and `dry-run` pass.
- The user explicitly approves the system-level scheduling step.
