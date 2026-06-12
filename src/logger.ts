export type LogLevel = "INFO" | "WARN" | "ERROR";

function write(level: LogLevel, message: string): void {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  if (level === "ERROR") {
    console.error(line);
    return;
  }
  console.log(line);
}

export const logger = {
  info(message: string): void {
    write("INFO", message);
  },
  warn(message: string): void {
    write("WARN", message);
  },
  error(message: string): void {
    write("ERROR", message);
  },
};

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function truncate(value: string, maxLength = 6_000): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength)}\n\n[output truncated]`;
}
