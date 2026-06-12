# Codex Instructions

Follow the safety rules in `CLAUDE.md`.

When the user asks to configure Agent Nightshift for a specific repository,
read and execute `docs/TARGET_REPOSITORY_SETUP.md`.

Do not install cron or change macOS wake schedules until:

- The target repository is known.
- The worker uses a separate, dedicated clone.
- `config.json` no longer points at this worker repository.
- `doctor` and `dry-run` pass.
- The user explicitly approves the system-level scheduling step.
