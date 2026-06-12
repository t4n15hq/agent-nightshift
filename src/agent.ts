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

// Only match wording the CLIs actually emit when out of capacity. Generic
// words like "limit", "usage", or "reset" appear in ordinary failures (stack
// traces, `git reset`, code that mentions rate limiting) and previously
// caused failed runs to be misclassified and retried forever.
const LIMIT_PATTERNS = [
  /usage limit/i,
  /rate[\s_-]?limit/i,
  /quota exceeded/i,
  /out of (credits|tokens)/i,
  /insufficient credit/i,
];

export function detectUsageLimit(exitCode: number, output: string): boolean {
  return exitCode !== 0 && LIMIT_PATTERNS.some((pattern) => pattern.test(output));
}

function getAgentArgs(config: WorkerConfig, prompt: string): string[] {
  if (config.agent === "claude") {
    return [...config.agentArgs, "-p", prompt];
  }
  return ["exec", "--sandbox", "workspace-write", ...config.agentArgs, prompt];
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
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    usageLimited: detectUsageLimit(
      result.exitCode,
      `${result.stdout}\n${result.stderr}`,
    ),
  };
}
