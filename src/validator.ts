import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { WorkerConfig } from "./config";
import { runCommand } from "./git";
import { logger, truncate } from "./logger";

export type ValidationStatus = "passed" | "failed" | "skipped";

export interface ValidationResult {
  command: string;
  status: ValidationStatus;
  exitCode?: number;
  output: string;
  reason?: string;
}

async function executableExists(command: string, env = process.env): Promise<boolean> {
  if (command.includes("/")) {
    try {
      await access(command, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    try {
      await access(path.join(directory, command), constants.X_OK);
      return true;
    } catch {
      // Continue searching PATH.
    }
  }
  return false;
}

function firstExecutable(command: string): string | undefined {
  const match = command.trim().match(/^([A-Za-z0-9_./-]+)/);
  return match?.[1];
}

async function packageScriptMissing(
  command: string,
  repoPath: string,
): Promise<string | undefined> {
  const match = command
    .trim()
    .match(/^(npm|pnpm|yarn|bun)\s+(?:run\s+)?([A-Za-z0-9:_-]+)(?:\s|$)/);
  if (!match) {
    return undefined;
  }
  const scriptName = match[2];
  const builtInCommands = new Set(["install", "ci", "exec", "x", "dlx"]);
  if (builtInCommands.has(scriptName)) {
    return undefined;
  }
  try {
    const packageJson = JSON.parse(
      await readFile(path.join(repoPath, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    return packageJson.scripts?.[scriptName]
      ? undefined
      : `package.json has no "${scriptName}" script`;
  } catch {
    return "package.json is missing or unreadable";
  }
}

export async function runValidation(
  config: WorkerConfig,
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  for (const command of config.validationCommands) {
    const executable = firstExecutable(command);
    if (!executable || !(await executableExists(executable))) {
      const reason = executable
        ? `executable "${executable}" was not found`
        : "command could not be parsed";
      logger.warn(`Skipping validation "${command}": ${reason}.`);
      results.push({ command, status: "skipped", output: "", reason });
      continue;
    }

    const missingScript = await packageScriptMissing(command, config.repoPath);
    if (missingScript) {
      logger.warn(`Skipping validation "${command}": ${missingScript}.`);
      results.push({
        command,
        status: "skipped",
        output: "",
        reason: missingScript,
      });
      continue;
    }

    logger.info(`Running validation: ${command}`);
    const result = await runCommand(command, [], {
      cwd: config.repoPath,
      shell: true,
      timeoutMs: config.validationTimeoutMinutes * 60_000,
      onStdout: (chunk) => process.stdout.write(chunk),
      onStderr: (chunk) => process.stderr.write(chunk),
    });
    const output = `${result.stdout}\n${result.stderr}`.trim();
    const status: ValidationStatus =
      result.exitCode === 0 && !result.timedOut ? "passed" : "failed";
    results.push({
      command,
      status,
      exitCode: result.exitCode,
      output,
      reason: result.timedOut ? "command timed out" : undefined,
    });
    if (status === "failed") {
      break;
    }
  }
  return results;
}

export function validationPassed(results: ValidationResult[]): boolean {
  return results.every((result) => result.status !== "failed");
}

export function formatValidationSummary(results: ValidationResult[]): string {
  if (results.length === 0) {
    return "No validation commands were configured.";
  }
  return results
    .map((result) => {
      const heading = `- \`${result.command}\`: **${result.status}**${
        result.reason ? ` (${result.reason})` : ""
      }`;
      if (!result.output) {
        return heading;
      }
      return `${heading}\n\n  \`\`\`text\n${truncate(result.output, 1_500)}\n  \`\`\``;
    })
    .join("\n");
}
