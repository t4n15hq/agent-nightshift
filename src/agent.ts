import type { WorkerConfig } from "./config";
import { runCommand } from "./git";
import { logger } from "./logger";

export interface AgentResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  usageLimited: boolean;
}

const LIMIT_PATTERNS = [
  /rate\s*limit/i,
  /usage\s*limit/i,
  /\blimit\b/i,
  /\busage\b/i,
  /\bquota\b/i,
  /try\s+again/i,
  /\breset\b/i,
];

function getAgentArgs(config: WorkerConfig, prompt: string): string[] {
  if (config.agent === "claude") {
    return ["-p", prompt];
  }
  return ["exec", "--sandbox", "workspace-write", prompt];
}

export async function runAgent(
  config: WorkerConfig,
  prompt: string,
): Promise<AgentResult> {
  logger.info(`Starting ${config.agent} agent.`);
  const result = await runCommand(
    config.agentCommand,
    getAgentArgs(config, prompt),
    {
      cwd: config.repoPath,
      timeoutMs: config.agentTimeoutMinutes * 60_000,
      onStdout: (chunk) => process.stdout.write(chunk),
      onStderr: (chunk) => process.stderr.write(chunk),
    },
  );
  const combined = `${result.stdout}\n${result.stderr}`;
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    usageLimited:
      result.exitCode !== 0 && LIMIT_PATTERNS.some((pattern) => pattern.test(combined)),
  };
}
