import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { minimatch } from "minimatch";

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  shell?: boolean;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

interface ProtectedFileSnapshot {
  kind: "file" | "symlink";
  contents: Buffer | string;
  mode: number;
}

export type ProtectedSnapshot = Map<string, ProtectedFileSnapshot>;

const SKIPPED_SCAN_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".venv",
  "node_modules",
]);

export function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: options.shell ?? false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    if (options.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      }, options.timeoutMs);
      timer.unref();
    }

    child.stdout?.on("data", (buffer: Buffer) => {
      const chunk = buffer.toString();
      stdout += chunk;
      options.onStdout?.(chunk);
    });
    child.stderr?.on("data", (buffer: Buffer) => {
      const chunk = buffer.toString();
      stderr += chunk;
      options.onStderr?.(chunk);
    });
    child.on("error", (error) => {
      if (timer) {
        clearTimeout(timer);
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      resolve({
        command: [command, ...args].join(" "),
        exitCode: code ?? 1,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

function assertSuccess(result: CommandResult, context: string): CommandResult {
  if (result.exitCode !== 0) {
    const details = result.stderr.trim() || result.stdout.trim() || "unknown error";
    throw new Error(`${context}: ${details}`);
  }
  return result;
}

function parseNullDelimited(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

export function matchesProtectedPath(
  file: string,
  patterns: string[],
): boolean {
  return patterns.some((pattern) =>
    minimatch(file, pattern, { dot: true, nocase: true }),
  );
}

async function listProtectedPaths(
  repoPath: string,
  patterns: string[],
): Promise<string[]> {
  const protectedPaths: string[] = [];

  async function walk(relativeDirectory: string): Promise<void> {
    const absoluteDirectory = path.join(repoPath, relativeDirectory);
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = path
        .join(relativeDirectory, entry.name)
        .replaceAll("\\", "/");
      if (entry.isDirectory()) {
        if (!SKIPPED_SCAN_DIRECTORIES.has(entry.name)) {
          await walk(relativePath);
        }
        continue;
      }
      if (
        (entry.isFile() || entry.isSymbolicLink()) &&
        matchesProtectedPath(relativePath, patterns)
      ) {
        protectedPaths.push(relativePath);
      }
    }
  }

  await walk("");
  return protectedPaths.sort();
}

export class GitClient {
  constructor(private readonly repoPath: string) {}

  private async git(args: string[], cwd = this.repoPath): Promise<CommandResult> {
    return runCommand("git", args, { cwd });
  }

  async assertRepository(): Promise<void> {
    assertSuccess(
      await this.git(["rev-parse", "--is-inside-work-tree"]),
      `${this.repoPath} is not a git repository`,
    );
  }

  async isClean(cwd = this.repoPath): Promise<boolean> {
    const result = assertSuccess(
      await this.git(["status", "--porcelain=v1", "--untracked-files=normal"], cwd),
      "Could not inspect the working tree",
    );
    return result.stdout.trim() === "";
  }

  async currentBranch(): Promise<string> {
    const result = assertSuccess(
      await this.git(["branch", "--show-current"]),
      "Could not determine the current branch",
    );
    const branch = result.stdout.trim();
    if (!branch) {
      throw new Error("The repository is in detached HEAD state.");
    }
    return branch;
  }

  async fetchBase(baseBranch: string): Promise<void> {
    assertSuccess(
      await this.git(["fetch", "--prune", "origin", baseBranch]),
      `Could not fetch origin/${baseBranch}`,
    );
  }

  async resolveBaseRef(baseBranch: string): Promise<string> {
    for (const ref of [`refs/remotes/origin/${baseBranch}`, `refs/heads/${baseBranch}`]) {
      const result = await this.git(["rev-parse", "--verify", "--quiet", ref]);
      if (result.exitCode === 0) {
        return ref;
      }
    }
    throw new Error(
      `Base branch "${baseBranch}" is not available locally or at origin/${baseBranch}.`,
    );
  }

  async canAccessBase(baseBranch: string): Promise<boolean> {
    try {
      const baseRef = await this.resolveBaseRef(baseBranch);
      const result = await this.git(["merge-base", "HEAD", baseRef]);
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  async branchExists(branch: string): Promise<boolean> {
    const local = await this.git([
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    if (local.exitCode === 0) {
      return true;
    }
    const remote = await this.git([
      "show-ref",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${branch}`,
    ]);
    return remote.exitCode === 0;
  }

  async createBranch(branch: string, baseRef: string): Promise<void> {
    assertSuccess(
      await this.git(["switch", "--create", branch, baseRef]),
      `Could not create branch ${branch}`,
    );
  }

  async switchBranch(branch: string, options?: { force?: boolean }): Promise<void> {
    const args = ["switch"];
    if (options?.force) {
      args.push("--discard-changes");
    }
    args.push(branch);
    assertSuccess(await this.git(args), `Could not switch back to ${branch}`);
  }

  async headSha(): Promise<string> {
    return assertSuccess(
      await this.git(["rev-parse", "HEAD"]),
      "Could not read the current commit",
    ).stdout.trim();
  }

  // Diff against the recorded branch point, not HEAD: agents sometimes commit
  // despite the prompt, and a HEAD-relative diff would then look empty and the
  // work would be discarded as "no changes".
  async changedFiles(baseRef: string, cwd = this.repoPath): Promise<string[]> {
    const tracked = assertSuccess(
      await this.git(["diff", "--name-only", "-z", baseRef], cwd),
      "Could not inspect changed files",
    );
    const untracked = assertSuccess(
      await this.git(["ls-files", "--others", "--exclude-standard", "-z"], cwd),
      "Could not inspect untracked files",
    );
    return [...new Set([...parseNullDelimited(tracked.stdout), ...parseNullDelimited(untracked.stdout)])]
      .map((file) => file.replaceAll("\\", "/"))
      .sort();
  }

  async diffLineCount(baseRef: string, cwd = this.repoPath): Promise<number> {
    const result = assertSuccess(
      await this.git(["diff", "--numstat", baseRef], cwd),
      "Could not calculate diff size",
    );
    let total = 0;
    for (const line of result.stdout.trim().split("\n")) {
      if (!line) {
        continue;
      }
      const [added, deleted] = line.split("\t");
      if (added === "-" || deleted === "-") {
        return Number.MAX_SAFE_INTEGER;
      }
      total += Number(added) + Number(deleted);
    }

    const untracked = parseNullDelimited(
      assertSuccess(
        await this.git(["ls-files", "--others", "--exclude-standard", "-z"], cwd),
        "Could not inspect untracked files",
      ).stdout,
    );
    for (const relativePath of untracked) {
      const absolutePath = path.resolve(cwd, relativePath);
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile() || fileStat.size > 2_000_000) {
        return Number.MAX_SAFE_INTEGER;
      }
      const content = await readFile(absolutePath);
      if (content.includes(0)) {
        return Number.MAX_SAFE_INTEGER;
      }
      const text = content.toString("utf8");
      total += text === "" ? 0 : text.replace(/\n$/, "").split("\n").length;
    }
    return total;
  }

  async snapshotProtectedFiles(patterns: string[]): Promise<ProtectedSnapshot> {
    const snapshot: ProtectedSnapshot = new Map();
    for (const relativePath of await listProtectedPaths(this.repoPath, patterns)) {
      const absolutePath = path.join(this.repoPath, relativePath);
      const fileStat = await lstat(absolutePath);
      if (fileStat.isSymbolicLink()) {
        snapshot.set(relativePath, {
          kind: "symlink",
          contents: await readlink(absolutePath),
          mode: fileStat.mode,
        });
      } else {
        snapshot.set(relativePath, {
          kind: "file",
          contents: await readFile(absolutePath),
          mode: fileStat.mode,
        });
      }
    }
    return snapshot;
  }

  async changedProtectedFiles(
    snapshot: ProtectedSnapshot,
    patterns: string[],
  ): Promise<string[]> {
    const currentPaths = new Set(await listProtectedPaths(this.repoPath, patterns));
    const allPaths = new Set([...snapshot.keys(), ...currentPaths]);
    const changed: string[] = [];

    for (const relativePath of allPaths) {
      const previous = snapshot.get(relativePath);
      if (!previous || !currentPaths.has(relativePath)) {
        changed.push(relativePath);
        continue;
      }
      const absolutePath = path.join(this.repoPath, relativePath);
      const fileStat = await lstat(absolutePath);
      if (previous.kind === "symlink") {
        if (
          !fileStat.isSymbolicLink() ||
          (await readlink(absolutePath)) !== previous.contents
        ) {
          changed.push(relativePath);
        }
      } else if (
        !fileStat.isFile() ||
        !(await readFile(absolutePath)).equals(previous.contents as Buffer)
      ) {
        changed.push(relativePath);
      }
    }
    return changed.sort();
  }

  async restoreProtectedFiles(
    snapshot: ProtectedSnapshot,
    patterns: string[],
  ): Promise<void> {
    const currentPaths = await listProtectedPaths(this.repoPath, patterns);
    for (const relativePath of currentPaths) {
      if (!snapshot.has(relativePath)) {
        await rm(path.join(this.repoPath, relativePath), {
          force: true,
          recursive: true,
        });
      }
    }

    for (const [relativePath, previous] of snapshot) {
      const absolutePath = path.join(this.repoPath, relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await rm(absolutePath, { force: true, recursive: true });
      if (previous.kind === "symlink") {
        await symlink(previous.contents as string, absolutePath);
      } else {
        await writeFile(absolutePath, previous.contents as Buffer);
        await chmod(absolutePath, previous.mode);
      }
    }
  }

  async discardChanges(): Promise<void> {
    assertSuccess(
      await this.git(["reset", "--hard", "HEAD"]),
      "Could not restore tracked files",
    );
    assertSuccess(
      await this.git(["clean", "-fd"]),
      "Could not remove files created by the agent",
    );
  }

  async deleteLocalBranch(branch: string): Promise<void> {
    const result = await this.git(["branch", "--delete", "--force", branch]);
    if (result.exitCode !== 0 && !result.stderr.includes("not found")) {
      throw new Error(`Could not delete local branch ${branch}: ${result.stderr.trim()}`);
    }
  }

  // The agent may have committed some or all of its work already, so an empty
  // stage is only an error when the branch also has no commits past baseSha.
  async commitAll(message: string, baseSha: string): Promise<string> {
    assertSuccess(await this.git(["add", "--all"]), "Could not stage changes");
    const staged = await this.git(["diff", "--cached", "--quiet"]);
    if (staged.exitCode !== 0) {
      assertSuccess(
        await this.git(["commit", "-m", message]),
        "Could not commit changes",
      );
    } else if ((await this.headSha()) === baseSha) {
      throw new Error("There were no changes to commit.");
    }
    return this.headSha();
  }

  async push(branch: string): Promise<void> {
    assertSuccess(
      await this.git(["push", "--set-upstream", "origin", branch]),
      `Could not push ${branch}`,
    );
  }
}

export function slugifyTitle(title: string, maxLength = 48): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug || "untitled";
}
