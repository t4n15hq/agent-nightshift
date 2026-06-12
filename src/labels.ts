import type { WorkerConfig } from "./config";

export interface LabelDefinition {
  name: string;
  color: string;
  description: string;
}

export function getLabelDefinitions(config: WorkerConfig): LabelDefinition[] {
  return [
    {
      name: config.labels.ready,
      color: "1D76DB",
      description: "Ready for the local overnight agent",
    },
    {
      name: config.labels.inProgress,
      color: "FBCA04",
      description: "Currently being handled by the overnight agent",
    },
    {
      name: config.labels.prOpened,
      color: "0E8A16",
      description: "The overnight agent opened a pull request",
    },
    {
      name: config.labels.blocked,
      color: "B60205",
      description: "The overnight agent could not safely complete the issue",
    },
    {
      name: config.labels.humanReview,
      color: "D93F0B",
      description: "Human review is required before automation continues",
    },
    {
      name: "agent-pr",
      color: "5319E7",
      description: "Pull request created by a local coding agent",
    },
  ];
}

export function issueStateLabels(config: WorkerConfig): string[] {
  return [
    config.labels.ready,
    config.labels.inProgress,
    config.labels.prOpened,
    config.labels.blocked,
    config.labels.humanReview,
  ];
}
