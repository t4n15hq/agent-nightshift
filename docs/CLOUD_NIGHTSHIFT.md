# Cloud Nightshift (`/nightshift` skill)

Cloud mode runs the overnight automation on Claude Code on the web instead of
your machine. A scheduled Routine spawns a fresh cloud session each night;
that session picks up at most one `claude-ready` issue, implements it on a
dedicated branch, validates, and opens a pull request for human review.

## Why cloud mode

- **Your laptop can be off.** The local worker depends on cron, `caffeinate`,
  and `pmset` wake schedules; if the machine sleeps, nothing runs. Cloud
  sessions run on Anthropic's infrastructure regardless.
- **Uses your overnight limits.** Claude subscription usage limits refresh on
  rolling windows. Capacity that would expire unused while you sleep gets
  spent working through your issue backlog instead.
- **Less setup.** Each cloud session is already a fresh, isolated clone, so
  the local mode's dedicated-clone, lock-file, and snapshot machinery isn't
  needed. No `config.json`, no cron, no Node build on your machine.

## Same safety model

Cloud mode carries over the local worker's rules, enforced by the prompt each
nightly session receives:

- At most one issue per run; label state machine
  (`claude-ready` → `claude-in-progress` → `claude-pr-opened` /
  `claude-blocked`).
- Dedicated `claude/issue-<number>-<slug>` branch from the base branch;
  never a second PR for a branch that already has one.
- Protected path patterns (`.env`, secrets, deploy, infra, auth, billing,
  migrations, permissions) and a max-diff-lines guard, checked before push.
- Validation commands discovered from the repo; failures open a draft PR or
  mark the issue blocked, per your choice.
- Usage-limit failures restore the issue to `claude-ready` for a later
  night, with a retry cap before it is marked blocked.
- **Never merges.** Every PR waits for a human.

One honest difference: the local worker enforces its guards in TypeScript
outside the agent, while cloud mode relies on the agent following its prompt
inside an isolated cloud sandbox. The isolation means a misbehaving run can
at worst push a bad branch/PR — which review catches — but treat it as
automation, not a security boundary, same as the local mode.

## Install

The skill lives at `.claude/skills/nightshift/` in this repository. Claude
Code loads project skills from the repo it is working in, so the skill must
be available in the **target** repository's session. Two options:

1. **Copy it into the target repo** (recommended): copy the
   `.claude/skills/nightshift/` directory into the target repository via a
   small PR. Anyone on the team can then run `/nightshift` from a Claude Code
   on the web session on that repo.
2. **Ask from this repo**: open a session on this repository and ask Claude
   to set up nightshift for `OWNER/REPO` — it will offer to open that setup
   PR for you.

## Set up

1. Open https://claude.ai/code and start a session on the **target**
   repository (nightly sessions inherit this session's environment).
2. Run `/nightshift`.
3. Answer the setup questions: night window and timezone, runs per night,
   draft-PR policy, notifications.
4. Review the schedule and the nightly prompt it shows you, then approve.

The skill installs the labels, verifies access, and creates the Routine only
after your explicit approval. Note that Routine schedules are in UTC and do
not track daylight-saving changes.

## Day-to-day use

- **Queue work:** add the `claude-ready` label to an issue. Small, focused,
  well-described issues work best.
- **Each morning:** review the PRs that were opened overnight. Merging is
  always yours.
- **Pause / resume / run now / uninstall:** run `/nightshift` again and ask,
  or manage the Routine directly from the claude.ai interface.

## Cloud mode vs. local worker

| | Local worker (`src/`) | Cloud skill (`/nightshift`) |
|---|---|---|
| Machine must be awake | Yes (cron + pmset) | No |
| Setup | Node build, `config.json`, cron | One skill invocation |
| Guard enforcement | TypeScript, outside the agent | Prompt rules + cloud sandbox isolation |
| Agent | Claude Code or Codex CLI | Claude Code on the web |
| Merging | Never (human review) | Never (human review) |

Both modes share the same labels, branch naming, and PR conventions, so you
can switch between them without migrating anything — just don't run both
against the same repository at the same time, or they may race to claim the
same issue.
