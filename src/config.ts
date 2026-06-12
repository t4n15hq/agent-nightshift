import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface LabelConfig {
  ready: string;
  inProgress: string;
  prOpened: string;
  blocked: string;
  humanReview: string;
}

export interface NightWindow {
  startHour: number;
  endHour: number;
}

export interface WorkerConfig {
  repoPath: string;
  owner: string;
  repo: string;
  baseBranch: string;
  agent: "claude" | "codex";
  agentCommand: string;
  nightWindow: NightWindow;
  labels: LabelConfig;
  validationCommands: string[];
  maxDiffLines: number;
  openDraftPrOnValidationFailure: boolean;
  protectedPathPatterns: string[];
  agentTimeoutMinutes: number;
  validationTimeoutMinutes: number;
}

export interface LoadedConfig {
  config: WorkerConfig;
  configPath: string;
}

function expandHome(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Configuration field "${name}" must be a non-empty string.`);
  }
  return value.trim();
}

function requireHour(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 23) {
    throw new Error(`Configuration field "${name}" must be an integer from 0 to 23.`);
  }
  return value as number;
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`Configuration field "${name}" must be a positive integer.`);
  }
  return value as number;
}

function requireStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Configuration field "${name}" must be an array of strings.`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function parseConfig(raw: unknown, configPath: string): WorkerConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Configuration must be a JSON object.");
  }

  const data = raw as Record<string, unknown>;
  const labels = data.labels as Record<string, unknown> | undefined;
  const nightWindow = data.nightWindow as Record<string, unknown> | undefined;
  if (!labels || typeof labels !== "object") {
    throw new Error('Configuration field "labels" is required.');
  }
  if (!nightWindow || typeof nightWindow !== "object") {
    throw new Error('Configuration field "nightWindow" is required.');
  }

  const agent = requireString(data.agent, "agent");
  if (agent !== "claude" && agent !== "codex") {
    throw new Error('Configuration field "agent" must be "claude" or "codex".');
  }

  const configuredRepoPath = expandHome(requireString(data.repoPath, "repoPath"));
  const repoPath = path.isAbsolute(configuredRepoPath)
    ? configuredRepoPath
    : path.resolve(path.dirname(configPath), configuredRepoPath);

  return {
    repoPath,
    owner: requireString(data.owner, "owner"),
    repo: requireString(data.repo, "repo"),
    baseBranch: requireString(data.baseBranch, "baseBranch"),
    agent,
    agentCommand: requireString(data.agentCommand, "agentCommand"),
    nightWindow: {
      startHour: requireHour(nightWindow.startHour, "nightWindow.startHour"),
      endHour: requireHour(nightWindow.endHour, "nightWindow.endHour"),
    },
    labels: {
      ready: requireString(labels.ready, "labels.ready"),
      inProgress: requireString(labels.inProgress, "labels.inProgress"),
      prOpened: requireString(labels.prOpened, "labels.prOpened"),
      blocked: requireString(labels.blocked, "labels.blocked"),
      humanReview: requireString(labels.humanReview, "labels.humanReview"),
    },
    validationCommands: requireStringArray(
      data.validationCommands,
      "validationCommands",
    ),
    maxDiffLines: requirePositiveInteger(data.maxDiffLines, "maxDiffLines"),
    openDraftPrOnValidationFailure:
      typeof data.openDraftPrOnValidationFailure === "boolean"
        ? data.openDraftPrOnValidationFailure
        : true,
    protectedPathPatterns: requireStringArray(
      data.protectedPathPatterns,
      "protectedPathPatterns",
    ),
    agentTimeoutMinutes:
      data.agentTimeoutMinutes === undefined
        ? 120
        : requirePositiveInteger(data.agentTimeoutMinutes, "agentTimeoutMinutes"),
    validationTimeoutMinutes:
      data.validationTimeoutMinutes === undefined
        ? 30
        : requirePositiveInteger(
            data.validationTimeoutMinutes,
            "validationTimeoutMinutes",
          ),
  };
}

export async function loadConfig(configArg?: string): Promise<LoadedConfig> {
  const requestedPath =
    configArg ?? process.env.CLAUDE_NIGHT_WORKER_CONFIG ?? "config.json";
  const configPath = path.resolve(expandHome(requestedPath));

  try {
    await access(configPath, constants.R_OK);
  } catch {
    throw new Error(
      `Cannot read ${configPath}. Copy config.example.json to config.json and configure it.`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in ${configPath}: ${String(error)}`);
  }

  return { config: parseConfig(raw, configPath), configPath };
}

export function isInsideNightWindow(
  window: NightWindow,
  now = new Date(),
): boolean {
  const hour = now.getHours();
  if (window.startHour <= window.endHour) {
    return hour >= window.startHour && hour <= window.endHour;
  }
  return hour >= window.startHour || hour <= window.endHour;
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}
