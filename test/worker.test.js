const assert = require("node:assert/strict");
const { mkdtemp, mkdir, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { detectUsageLimit } = require("../dist/agent");
const { isInsideNightWindow } = require("../dist/config");
const {
  GitClient,
  matchesProtectedPath,
  runCommand,
  slugifyTitle,
} = require("../dist/git");

test("slugifyTitle creates deterministic branch-safe text", () => {
  assert.equal(slugifyTitle("Fix: Café login / timeout!"), "fix-cafe-login-timeout");
  assert.equal(slugifyTitle("???"), "untitled");
});

test("night windows support same-day and overnight ranges", () => {
  const atHour = (hour) => new Date(2026, 0, 1, hour, 30);
  assert.equal(
    isInsideNightWindow({ startHour: 0, endHour: 6 }, atHour(6)),
    true,
  );
  assert.equal(
    isInsideNightWindow({ startHour: 0, endHour: 6 }, atHour(7)),
    false,
  );
  assert.equal(
    isInsideNightWindow({ startHour: 22, endHour: 4 }, atHour(23)),
    true,
  );
  assert.equal(
    isInsideNightWindow({ startHour: 22, endHour: 4 }, atHour(12)),
    false,
  );
});

test("protected path matching covers root and nested sensitive files", () => {
  const patterns = [".env", "**/.env.*", "**/*secret*", "**/auth/**"];
  assert.equal(matchesProtectedPath(".env", patterns), true);
  assert.equal(matchesProtectedPath("apps/api/.env.production", patterns), true);
  assert.equal(matchesProtectedPath("src/auth/session.ts", patterns), true);
  assert.equal(matchesProtectedPath("src/secret-key.ts", patterns), true);
  assert.equal(matchesProtectedPath("src/routes.ts", patterns), false);
});

test("usage limit detection matches real limit wording only", () => {
  assert.equal(detectUsageLimit(1, "Claude usage limit reached. Try again at 6am."), true);
  assert.equal(detectUsageLimit(1, "API rate limit exceeded"), true);
  assert.equal(detectUsageLimit(0, "usage limit reached"), false);
  assert.equal(detectUsageLimit(1, "fatal: ambiguous argument after git reset"), false);
  assert.equal(detectUsageLimit(1, "TypeError: cannot read usage of undefined"), false);
  assert.equal(detectUsageLimit(1, "exceeded the line limit in config"), false);
});

test("diffs are measured against the branch point even when the agent commits", async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), "night-worker-git-"));
  const git = new GitClient(repoPath);
  const run = async (...args) => {
    const result = await runCommand("git", args, { cwd: repoPath });
    assert.equal(result.exitCode, 0, result.stderr);
    return result;
  };

  try {
    await run("init", "--initial-branch=main");
    await run("config", "user.email", "test@example.com");
    await run("config", "user.name", "Test");
    await writeFile(path.join(repoPath, "a.txt"), "one\n");
    await run("add", "--all");
    await run("commit", "-m", "base");
    const baseSha = await git.headSha();

    // The agent edits a file and commits it, despite being told not to.
    await writeFile(path.join(repoPath, "a.txt"), "one\ntwo\n");
    await run("add", "--all");
    await run("commit", "-m", "agent commit");
    // Plus an uncommitted new file.
    await writeFile(path.join(repoPath, "b.txt"), "new\n");

    assert.deepEqual(await git.changedFiles(baseSha), ["a.txt", "b.txt"]);
    assert.equal(await git.diffLineCount(baseSha), 2);

    // commitAll picks up the stragglers and keeps the agent's commit.
    const sha = await git.commitAll("worker commit", baseSha);
    assert.notEqual(sha, baseSha);
    assert.equal(await git.isClean(), true);

    // A second commitAll with nothing new is a no-op, not an error.
    assert.equal(await git.commitAll("noop", baseSha), sha);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("protected snapshots detect and restore ignored-style files", async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), "night-worker-test-"));
  const patterns = [".env", "**/*credential*"];
  const envPath = path.join(repoPath, ".env");
  const credentialPath = path.join(repoPath, "tmp", "credential.json");

  try {
    await writeFile(envPath, "TOKEN=original\n");
    const git = new GitClient(repoPath);
    const snapshot = await git.snapshotProtectedFiles(patterns);

    await writeFile(envPath, "TOKEN=changed\n");
    await mkdir(path.dirname(credentialPath), { recursive: true });
    await writeFile(credentialPath, "new credential\n");

    assert.deepEqual(await git.changedProtectedFiles(snapshot, patterns), [
      ".env",
      "tmp/credential.json",
    ]);

    await git.restoreProtectedFiles(snapshot, patterns);
    assert.equal(await readFile(envPath, "utf8"), "TOKEN=original\n");
    await assert.rejects(readFile(credentialPath, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});
