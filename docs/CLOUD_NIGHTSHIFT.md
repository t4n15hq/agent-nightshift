# Cloud Nightshift (`/nightshift` skill)

Cloud mode runs the overnight automation on Claude Code on the web instead of
your machine. You run `/nightshift` once; from then on, a scheduled Routine
spawns a fresh cloud session each night that tends yesterday's agent PRs,
picks up at most one new issue, implements it, and opens a pull request for
human review. The only recurring human jobs left are reviewing/merging PRs
and, optionally, labeling issues to prioritize them.

## Why cloud mode

- **Your laptop can be off.** The local worker depends on cron,
  `caffeinate`, and `pmset` wake schedules; if the machine sleeps, nothing
  runs. Cloud sessions run on Anthropic's infrastructure regardless.
- **Uses your overnight limits.** Claude subscription usage limits refresh
  on rolling windows. Capacity that would expire unused while you sleep gets
  spent working through your issue backlog instead.
- **Set-and-forget.** One invocation installs everything. Each cloud session
  is already a fresh, isolated clone, so the local mode's dedicated-clone,
  lock-file, and snapshot machinery isn't needed — no `config.json`, no
  cron, no Node build on your machine.

## The nightly pipeline

Each night's session runs these stages in order:

1. **Self-check.** Verifies repo access and labels (recreating missing
   labels). After three consecutive nights of the same systemic failure
   (expired auth, archived repo), it disables its own schedule and says so
   loudly in the log — the automation fails loud, not silent.
2. **Steward existing PRs.** Before starting anything new, it tends open
   `claude/issue-*` PRs: rebases conflicts, fixes CI failures its own diff
   caused, and addresses concrete review comments left during the day. A
   substantial fix consumes that night's coding budget.
3. **Pick one issue.** Human-labeled `claude-ready` issues first; in the
   default `auto` mode, when none are labeled it triages the backlog itself
   and picks only a clearly safe, small, well-specified issue. If nothing
   qualifies, it does nothing — **a quiet night beats a slop PR.**
4. **Implement, validate, self-review.** See the quality bar below.
5. **Ship.** Protected-path and diff-size guards, single squashed commit,
   PR with honest notes on what was and wasn't verified. Never merges.
6. **Log.** Appends one structured comment to a rolling "🌙 Nightshift log"
   issue — the automation's memory across sessions and your audit trail.

## The quality bar (anti-slop)

Unattended volume is worthless if the output is slop, so the nightly prompt
bakes in a minimal-diff discipline adapted from
[Ponytail](https://github.com/DietrichGebert/ponytail) ("makes your AI agent
think like the laziest senior dev in the room"):

- **Understand first, then be lazy** — read the issue, the code, and the
  real flow before deciding anything.
- **Decision ladder** — before writing code: does this need to exist at
  all → does the codebase already do it → stdlib → platform → installed
  dependency → one-liner → only then the minimum working implementation.
- **Hard rules** — root causes over symptoms; no unasked abstractions, new
  dependencies, boilerplate, or drive-by refactors; deletion over addition,
  boring over clever, shortest working diff.
- **Never lazy about** — trust-boundary validation, error handling,
  security, accessibility, and a runnable check for any non-trivial logic.
- **Self-review gate** — before pushing, the agent re-reads its full diff
  as a skeptical reviewer and does an explicit shrink pass. If it cannot
  honestly say the change is correct, minimal, and better than nothing, it
  reverts and writes up what it tried instead of opening a PR.

## Same safety model as local mode

- At most one new issue per run; label state machine (`claude-ready` →
  `claude-in-progress` → `claude-pr-opened` / `claude-blocked`).
- Dedicated `claude/issue-<number>-<slug>` branch; never a second PR for a
  branch that already has one; stale claims reclaimed after 3 hours.
- Protected path patterns (`.env`, secrets, deploy, infra, auth, billing,
  migrations, permissions) and a max-diff-lines guard, checked before push.
- Validation failures open a draft PR or mark the issue blocked, per your
  choice; usage-limit failures restore the issue for a later night, with a
  retry cap.
- **Never merges.** Every PR waits for a human.

One honest difference: the local worker enforces its guards in TypeScript
outside the agent, while cloud mode relies on the agent following its prompt
inside an isolated cloud sandbox. The isolation means a misbehaving run can
at worst push a bad branch/PR — which review catches — but treat it as
automation, not a security boundary, same as the local mode.

## Set up (once)

1. Open https://claude.ai/code and start a session — ideally on the target
   repository, but any session with this skill available works: the skill
   can bind the schedule to another repo's environment, as long as you've
   opened that repo on claude.ai/code at least once.
2. Run `/nightshift` (from a session on this repo, just ask Claude to set up
   nightshift for `OWNER/REPO`).
3. Answer one round of questions — night window and timezone, issue
   selection mode, draft-PR policy, notifications — and approve the schedule
   it shows you.

The skill installs the labels and log issue, verifies access, and creates
the Routine only after your explicit approval. Note that Routine schedules
are in UTC and do not track daylight-saving changes.

## Tuning later without re-setup

Setup offers to commit a `.claude/nightshift.json` to the target repo.
Nightly runs merge that file over their built-in defaults, so changing the
diff cap, labels, triage mode, validation commands, or failure policy is an
ordinary one-line commit — the Routine never needs rebuilding. Schedule
changes are the only thing that lives in the Routine itself (`/nightshift`
handles "retune", "pause", "run now", "status", and "uninstall").

## Day-to-day use

- **Prioritize work:** add `claude-ready` to an issue to put it at the front
  of the queue; add `nightshift-skip` to keep the auto-triage away from one.
- **Each morning:** review the PRs that were opened or updated overnight.
  Merging is always yours. Review comments you leave get addressed the next
  night by the steward stage.
- **Check on it anytime:** the "🌙 Nightshift log" issue shows every run's
  outcome; `/nightshift status` summarizes it.

## Cloud mode vs. local worker

| | Local worker (`src/`) | Cloud skill (`/nightshift`) |
|---|---|---|
| Machine must be awake | Yes (cron + pmset) | No |
| Setup | Node build, `config.json`, cron | One skill invocation |
| Issue intake | `claude-ready` labels only | Labels, auto-triage, or opt-out |
| Tends its own PRs | No | Yes (steward stage) |
| Failure behavior | Log file on the machine | Log issue + self-disable |
| Guard enforcement | TypeScript, outside the agent | Prompt rules + cloud sandbox isolation |
| Agent | Claude Code or Codex CLI | Claude Code on the web |
| Merging | Never (human review) | Never (human review) |

Both modes share the same labels, branch naming, and PR conventions, so you
can switch between them without migrating anything — just don't run both
against the same repository at the same time, or they may race to claim the
same issue.
