const assert = require("node:assert/strict");
const { mkdtemp, mkdir, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { isInsideNightWindow } = require("../dist/config");
const {
  GitClient,
  matchesProtectedPath,
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
