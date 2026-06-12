# Review and Reliability Fixes — 2026-06-11

This documents a full review of the night worker and the reasoning behind the
changes shipped with it. The goal of the project: use idle overnight Claude
usage limits to implement labeled GitHub issues unattended, with PRs ready for
human review in the morning. The review question was "will it actually do that
on night one?" — and the answer was no, for two reasons that had nothing to do
with code quality.

## What was already good

- Clear module separation: config parsing, git operations, GitHub CLI calls,
  agent invocation, and validation each live in one file.
- Real safety engineering: protected-file snapshots that cover git-ignored
  files like `.env` (something a plain `git diff` can never catch), a re-check
  of protected paths and diff size *after* validation runs, stale-lock
  detection with PID liveness, deterministic branch names, draft PRs on
  validation failure, and no auto-merge anywhere.
- The build and the test suite passed before any changes.

The fixes below are about failure modes around the edges, not the core design.

## Blocker 1: headless Claude could never edit a file

`claude -p "<prompt>"` was invoked with no permission flags. In print mode,
Claude Code cannot ask for tool approval, so any Edit/Write/Bash call is
auto-denied. The agent would read the codebase, be unable to write anything,
and exit — and the worker would then mark every issue `claude-blocked` with
"the agent completed without making any file changes". Every issue, every
night, while still consuming usage.

The README's "never uses permission-bypass flags" stance was the right
instinct pointed at the wrong layer. The worker already has its own guardrails
(protected-path snapshot/restore, diff caps, branch isolation, no push without
checks), so the agent does not need full bypass — it needs exactly one thing:
the ability to edit files.

**Decision:** add an `agentArgs` config array, defaulting for Claude to
`--permission-mode acceptEdits`. That auto-approves file edits only; arbitrary
shell commands stay denied, and the worker's validation step compensates for
the agent not running tests itself. Users who want the agent to run tests can
extend `agentArgs` with `--allowedTools` entries. `--dangerously-skip-permissions`
remains deliberately unused.

## Blocker 2: the machine is asleep when cron fires

macOS skips cron jobs while asleep and does not replay them. A laptop closed at
midnight runs nothing, which defeats the entire premise.

**Decision:** two-part fix, because the two problems are different:

1. *Staying awake during a run* — `install-cron.sh` now prefixes the command
   with `caffeinate -i` when available, so a 90-minute agent run is not
   suspended by idle sleep.
2. *Being awake when the run starts* — `caffeinate` cannot wake a sleeping
   machine, so the README and the install script now instruct scheduling a
   wake with `sudo pmset repeat wakeorpoweron MTWRFSU 00:04:00` (one minute
   before the first tick). This needs root once, so it is documented rather
   than automated.

A launchd LaunchAgent was considered (it replays one missed run on wake) but
cron + pmset was kept: it preserves the existing install flow and the
30-minute tick means a missed run self-heals at the next tick anyway.

Related: credentials for `claude` and `gh` live in the login keychain, which
stays unlocked while the user is logged in even with the screen locked — so
the docs say "stay logged in", not "disable the lock screen".

## High: usage-limit false positives caused silent infinite retries

The limit detection matched `/\blimit\b/i`, `/\busage\b/i`, `/\breset\b/i`,
and `/try\s+again/i` against agent output on any nonzero exit. Almost any
failure output mentions one of those words (`git reset`, stack traces, code
about rate limiting). A misclassified failure was restored to `claude-ready`
and retried on all 14 cron ticks per night, forever, with no terminal state
and nothing telling the human.

**Decision (two layers, because regexes against CLI text are inherently
fragile):**

1. Match only wording the CLIs actually emit when out of capacity
   (`usage limit`, `rate limit`, `quota exceeded`, `out of credits/tokens`,
   `insufficient credit`).
2. Cap the loop regardless: each restore-to-ready leaves a marker comment
   (`<!-- night-worker-usage-limit-retry -->`) on the issue; once the count
   reaches `maxUsageLimitRetries` (default 5), the issue is marked
   `claude-blocked` with an explanation. The cap means even a future false
   positive costs at most N wasted runs, not an unbounded loop. Issue comments
   were chosen as the counter store because they survive crashes and are
   visible to the human, unlike local state files.

## Medium: an agent that commits destroyed its own work

`changedFiles()` and `diffLineCount()` diffed against `HEAD`. The prompt tells
the agent not to commit, but agents sometimes do (a target repo's own
CLAUDE.md may even instruct it). A committed change made the diff-vs-HEAD
empty, so the worker concluded "no file changes", deleted the branch, and the
finished work evaporated. It also meant committed changes bypassed the
tracked-file protected-path check.

**Decision:** record the SHA at branch creation (`baseSha`) and diff against
it everywhere. `commit()` became `commitAll(message, baseSha)`: it stages
everything, commits only if anything is staged, and treats an empty stage as
an error only when the branch also has no commits past `baseSha` — so agent
commits are kept and pushed rather than rejected. Cleanup now force-switches
(`git switch --discard-changes`) back to the original branch, because
restoring a protected-file snapshot over an agent *commit* leaves the tree
dirty and a plain switch would strand the repo on the worker branch.

While testing this, a pre-existing off-by-one surfaced: untracked files ending
in a newline were counted one line too long in `diffLineCount`. Fixed.

## Medium: a hard crash stranded the issue forever

If the process died (power loss, SIGKILL, forced sleep) after the
`claude-in-progress` label was set, nothing ever removed it: `findNextIssue`
skips labeled issues, so the issue became permanently invisible. The stale
*lock* was already handled; the stale *label* was not.

**Decision:** at the start of each run — after the lock is held, so no other
worker can race — list issues labeled `claude-in-progress` and reconcile each:
if a PR exists for its deterministic branch, set `claude-pr-opened` (or
`human-review-required` for a closed PR); otherwise return it to
`claude-ready` with an explanatory comment. Holding the lock is what makes
"any in-progress label seen now is stale" a safe assumption.

## Small fixes

- **Retry relabeling trap:** the README said "re-label `claude-ready` to
  retry", but `findNextIssue` ignored any issue still carrying
  `claude-blocked` or `human-review-required`, so the human's retry request
  was silently ignored. Since a failed run always strips the ready label,
  `ready` coexisting with a terminal label can only mean a human re-added it.
  `findNextIssue` now treats only the *active* labels (`in-progress`,
  `pr-opened`) as ineligible.
- **`commandExists`** rejected with a raw `spawn ENOENT` instead of returning
  false when a binary was missing; now caught.

## Known limitations, accepted deliberately

- Issue bodies go verbatim into the agent prompt. On a repo where only the
  owner labels issues `claude-ready`, that trust model is fine; do not use
  the worker on repos where strangers can edit issues you label.
- The limit-detection regexes can still false-positive (e.g. a failing issue
  about rate limiting); the retry cap bounds the damage to N runs.
- `dist/` stays committed so cron needs no build step; it can drift from
  `src/` if a change is committed without `npm run build` (the test script
  builds first, which mitigates this).
- The current `config.json` pointing the worker at this repository itself is
  fine for smoke-testing, but real use should point `repoPath` at a dedicated
  clean clone of the target project, per the README.
