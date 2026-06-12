import type { GitHubIssue } from "./github";

export function buildPrompt(issue: GitHubIssue): string {
  return `You are working inside this repository.

Implement exactly one GitHub issue.

Issue:
#${issue.number} ${issue.title}
${issue.url}

Body:
${issue.body || "(No issue body provided.)"}

Rules:
- First inspect the relevant code.
- Read and follow CLAUDE.md or other repository-specific agent instructions.
- Make the smallest correct change.
- Do not modify unrelated files.
- Do not perform broad refactors.
- Do not touch secrets, env files, deployment config, billing, auth, permissions, migrations, or infrastructure unless the issue explicitly requires it.
- Do not delete data.
- Add or update tests if appropriate.
- Run relevant checks if possible.
- If the issue is ambiguous, make a minimal reasonable fix and explain assumptions.
- If the issue is unsafe or impossible, stop and write a clear explanation.
- Do not commit, push, open a pull request, merge, or change GitHub labels. The worker handles git and GitHub operations.
- At the end, summarize:
  1. Files changed
  2. What was fixed
  3. Tests/checks run
  4. Risks or follow-ups
`;
}
